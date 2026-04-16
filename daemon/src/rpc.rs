//! JSON-RPC 2.0 over stdio, line-delimited JSON.
//!
//! v1 uses newline-framed messages. Both requests and notifications look
//! like `{"jsonrpc":"2.0", ...}` with one message per line on `stdin`/
//! `stdout`. This is easier to debug than LSP-style Content-Length framing
//! and avoids a dependency on a JSON-RPC crate.
//!
//! Method table (`spec §4`):
//! - `workspace.scan`           — start/force a workspace scan
//! - `workspace.healthSummary`  — return current file-level scores
//! - `file.diagnostics`         — per-file diagnostic snapshot
//! - `slice.compute`            — workstream C (stubbed)
//! - `summary.generate`         — workstream G (offline stub)
//! - `symbol.definition`        — best-effort via state index
//! - `symbol.references`        — best-effort via state index
//! - `cache.invalidate`         — drop blob entries
//!
//! Events are emitted as notifications with method `daemon.event` and the
//! `DaemonEvent` union as `params`.

use crate::analyzers::{grounding, joern, lsp, semgrep};
use crate::contracts::{
    CacheInvalidateRequest, DaemonEvent, FileRequest, HealthScore, Location, LocationRequest,
    SliceRequest, SummaryRequest,
};
use crate::state::SharedState;
use crate::watcher;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tracing::{error, warn};

#[derive(Debug, Clone, Deserialize)]
pub struct RpcRequest {
    #[serde(default)]
    pub jsonrpc: String,
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct RpcResponse {
    pub jsonrpc: &'static str,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    fn invalid_params(msg: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: msg.into(),
            data: None,
        }
    }
    fn method_not_found(method: &str) -> Self {
        Self {
            code: -32601,
            message: format!("method not found: {method}"),
            data: None,
        }
    }
    fn internal(msg: impl Into<String>) -> Self {
        Self {
            code: -32603,
            message: msg.into(),
            data: None,
        }
    }
    fn parse_error() -> Self {
        Self {
            code: -32700,
            message: "parse error".into(),
            data: None,
        }
    }
}

pub async fn serve_stdio(state: SharedState) -> anyhow::Result<()> {
    let stdin = tokio::io::stdin();
    let stdout = Arc::new(tokio::sync::Mutex::new(tokio::io::stdout()));
    let (ev_tx, mut ev_rx) = crate::events::channel();

    // Spawn an event-forwarder that serialises DaemonEvents onto stdout as
    // `daemon.event` notifications.
    let stdout_ev = Arc::clone(&stdout);
    tokio::spawn(async move {
        while let Some(ev) = ev_rx.recv().await {
            let frame = json!({
                "jsonrpc": "2.0",
                "method": "daemon.event",
                "params": ev,
            });
            if let Ok(text) = serde_json::to_string(&frame) {
                let mut w = stdout_ev.lock().await;
                let _ = w.write_all(text.as_bytes()).await;
                let _ = w.write_all(b"\n").await;
                let _ = w.flush().await;
            }
        }
    });

    let mut reader = BufReader::new(stdin).lines();

    while let Some(line) = reader.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let (id, response) = dispatch_line(&line, Arc::clone(&state), ev_tx.clone()).await;
        let Some(id) = id else { continue }; // notifications have no response
        let mut w = stdout.lock().await;
        let text = serde_json::to_string(&RpcResponse {
            jsonrpc: "2.0",
            id,
            result: response.result,
            error: response.error,
        })?;
        w.write_all(text.as_bytes()).await?;
        w.write_all(b"\n").await?;
        w.flush().await?;
    }

    Ok(())
}

pub struct DispatchOutcome {
    pub result: Option<Value>,
    pub error: Option<RpcError>,
}

async fn dispatch_line(
    line: &str,
    state: SharedState,
    ev_tx: mpsc::UnboundedSender<DaemonEvent>,
) -> (Option<Value>, DispatchOutcome) {
    let req: RpcRequest = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => {
            warn!(error = %e, line = %line, "malformed RPC line");
            return (
                Some(json!(null)),
                DispatchOutcome {
                    result: None,
                    error: Some(RpcError::parse_error()),
                },
            );
        }
    };
    let id = req.id.clone();
    let outcome = match dispatch_method(&req, state, ev_tx).await {
        Ok(v) => DispatchOutcome {
            result: Some(v),
            error: None,
        },
        Err(e) => DispatchOutcome {
            result: None,
            error: Some(e),
        },
    };
    (id, outcome)
}

pub async fn dispatch_method(
    req: &RpcRequest,
    state: SharedState,
    ev_tx: mpsc::UnboundedSender<DaemonEvent>,
) -> Result<Value, RpcError> {
    match req.method.as_str() {
        "workspace.scan" => {
            watcher::rescan_workspace(&state, &ev_tx)
                .await
                .map_err(|e| RpcError::internal(format!("scan failed: {e}")))?;
            Ok(Value::Null)
        }
        "workspace.healthSummary" => {
            let w = state.workspace.read().await;
            let mut scores: Vec<HealthScore> = w.file_scores.values().cloned().collect();
            scores.sort_by(|a, b| {
                b.composite
                    .partial_cmp(&a.composite)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            Ok(serde_json::to_value(scores).expect("serialise scores"))
        }
        "file.diagnostics" => {
            let params: FileRequest = serde_json::from_value(req.params.clone())
                .map_err(|e| RpcError::invalid_params(format!("{e}")))?;
            let w = state.workspace.read().await;
            let diags = w.diagnostics.get(&params.file).cloned().unwrap_or_default();
            Ok(serde_json::to_value(diags).unwrap())
        }
        "file.list" => {
            // Convenience: list scanned files with LOC + language.
            let w = state.workspace.read().await;
            let mut list: Vec<Value> = w
                .files
                .values()
                .map(|f| {
                    json!({
                        "file": f.relative_path,
                        "loc": f.loc,
                        "language": format!("{:?}", f.language),
                    })
                })
                .collect();
            list.sort_by(|a, b| a["file"].as_str().cmp(&b["file"].as_str()));
            Ok(Value::Array(list))
        }
        "slice.compute" => {
            let _params: SliceRequest = serde_json::from_value(req.params.clone())
                .map_err(|e| RpcError::invalid_params(format!("{e}")))?;
            let _ = ev_tx.send(DaemonEvent::CapabilityDegraded {
                capability: "cpg".into(),
                reason: joern::degraded_reason().into(),
            });
            Err(RpcError {
                code: -32000,
                message: joern::degraded_reason().into(),
                data: Some(json!({"capability": "cpg"})),
            })
        }
        "summary.generate" => {
            let params: SummaryRequest = serde_json::from_value(req.params.clone())
                .map_err(|e| RpcError::invalid_params(format!("{e}")))?;
            let w = state.workspace.read().await;
            for file in w.files.values() {
                if let Some(unit) = file.functions.iter().find(|f| f.symbol_id == params.symbol) {
                    return Ok(serde_json::to_value(grounding::offline_summary(file, unit)).unwrap());
                }
            }
            Err(RpcError::invalid_params(format!(
                "symbol not found: {}",
                params.symbol
            )))
        }
        "symbol.definition" => {
            let params: LocationRequest = serde_json::from_value(req.params.clone())
                .map_err(|e| RpcError::invalid_params(format!("{e}")))?;
            Ok(serde_json::to_value(find_symbol_at(&state, &params.location).await).unwrap())
        }
        "symbol.references" => {
            let params: LocationRequest = serde_json::from_value(req.params.clone())
                .map_err(|e| RpcError::invalid_params(format!("{e}")))?;
            Ok(serde_json::to_value(find_references(&state, &params.location).await).unwrap())
        }
        "cache.invalidate" => {
            let params: CacheInvalidateRequest = serde_json::from_value(req.params.clone())
                .unwrap_or(CacheInvalidateRequest { file: None });
            if let Some(_file) = params.file {
                // v1: trivial — full invalidate on scan
            }
            Ok(Value::Null)
        }
        "capabilities.status" => Ok(json!({
            "cpg": { "available": false, "reason": joern::degraded_reason() },
            "lsp": { "available": false, "reason": lsp::degraded_reason() },
            "semgrep": {
                "available": semgrep::binary_present(),
                "reason": if semgrep::binary_present() { "ready" } else { semgrep::degraded_reason() },
            },
            "llm": { "available": false, "reason": "workstream G stub — configure API key when landed" },
        })),
        "ping" => Ok(json!("pong")),
        "daemon.info" => Ok(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "root": state.root.to_string_lossy(),
        })),
        other => {
            error!(method = %other, "unknown method");
            Err(RpcError::method_not_found(other))
        }
    }
}

async fn find_symbol_at(state: &SharedState, loc: &Location) -> Option<Location> {
    let w = state.workspace.read().await;
    let file = w.files.get(&loc.file)?;
    let (line, col) = (loc.range.start[0], loc.range.start[1]);
    let mut best: Option<&crate::parser::FunctionUnit> = None;
    for f in &file.functions {
        let r = &f.location.range;
        let inside = (r.start[0], r.start[1]) <= (line, col)
            && (r.end[0], r.end[1]) >= (line, col);
        if inside {
            best = match best {
                None => Some(f),
                Some(prev) => {
                    let prev_span = span_size(prev);
                    let cur_span = span_size(f);
                    if cur_span <= prev_span { Some(f) } else { Some(prev) }
                }
            };
        }
    }
    best.map(|f| f.location.clone())
}

fn span_size(f: &crate::parser::FunctionUnit) -> u64 {
    let r = &f.location.range;
    let end = ((r.end[0] as u64) << 32) | r.end[1] as u64;
    let start = ((r.start[0] as u64) << 32) | r.start[1] as u64;
    end.saturating_sub(start)
}

async fn find_references(state: &SharedState, loc: &Location) -> Vec<Location> {
    let Some(def) = find_symbol_at(state, loc).await else {
        return vec![];
    };
    let w = state.workspace.read().await;
    let Some(file) = w.files.get(&def.file) else { return vec![] };
    let Some(target) = file.functions.iter().find(|f| f.location == def) else {
        return vec![];
    };
    let leaf = target.name.rsplit('.').next().unwrap_or(&target.name).to_string();
    let mut out = Vec::new();
    for file in w.files.values() {
        for func in &file.functions {
            if func.local_callees.iter().any(|c| c.ends_with(&leaf)) {
                out.push(func.location.clone());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ping_pongs() {
        let state = crate::state::State::new(std::env::temp_dir(), crate::config::Config::default());
        let (tx, _rx) = crate::events::channel();
        let req = RpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "ping".into(),
            params: Value::Null,
        };
        let v = dispatch_method(&req, state, tx).await.unwrap();
        assert_eq!(v, json!("pong"));
    }

    #[tokio::test]
    async fn slice_compute_returns_capability_error() {
        let state = crate::state::State::new(std::env::temp_dir(), crate::config::Config::default());
        let (tx, _rx) = crate::events::channel();
        let req = RpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "slice.compute".into(),
            params: json!({
                "origin": {
                    "file": "a.py",
                    "range": {"start": [0,0], "end": [0,0]}
                },
                "direction": "backward",
                "kind": "thin",
                "crossFile": true
            }),
        };
        let err = dispatch_method(&req, state, tx).await.unwrap_err();
        assert_eq!(err.code, -32000);
    }

    #[tokio::test]
    async fn unknown_method_is_a_method_not_found() {
        let state = crate::state::State::new(std::env::temp_dir(), crate::config::Config::default());
        let (tx, _rx) = crate::events::channel();
        let req = RpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "nope".into(),
            params: Value::Null,
        };
        let err = dispatch_method(&req, state, tx).await.unwrap_err();
        assert_eq!(err.code, -32601);
    }
}
