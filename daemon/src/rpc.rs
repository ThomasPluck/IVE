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

use crate::analyzers::{grounding, joern, lsp, pytea, rust_analyzer, semgrep, slice};
use crate::contracts::{
    CacheInvalidateRequest, DaemonEvent, FileRequest, HealthScore, Location, LocationRequest,
    SliceRequest, SummaryRequest,
};
use crate::parser::Language;
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

    // Background debounced file watcher. We hold the handle for the
    // lifetime of `serve_stdio` — drop ends the watcher cleanly.
    let _watch_handle = match watcher::spawn(Arc::clone(&state), ev_tx.clone()) {
        Ok(h) => Some(h),
        Err(e) => {
            tracing::warn!(error = %e, "file watcher unavailable — steady-state deltas disabled");
            None
        }
    };

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
            let params: SliceRequest = serde_json::from_value(req.params.clone())
                .map_err(|e| RpcError::invalid_params(format!("{e}")))?;
            handle_slice_compute(params, &state, &ev_tx).await
        }
        "summary.generate" => {
            let params: SummaryRequest = serde_json::from_value(req.params.clone())
                .map_err(|e| RpcError::invalid_params(format!("{e}")))?;
            // Clone the pieces we need so we can drop the read lock before
            // a potentially blocking LLM call.
            let pair = {
                let w = state.workspace.read().await;
                w.files.values().find_map(|file| {
                    file.functions
                        .iter()
                        .find(|f| f.symbol_id == params.symbol)
                        .map(|unit| (file.clone(), unit.clone()))
                })
            };
            match pair {
                Some((file, unit)) => {
                    let summary =
                        tokio::task::spawn_blocking(move || grounding::summarize(&file, &unit))
                            .await
                            .map_err(|e| RpcError::internal(format!("summary task: {e}")))?;
                    Ok(serde_json::to_value(summary).unwrap())
                }
                None => Err(RpcError::invalid_params(format!(
                    "symbol not found: {}",
                    params.symbol
                ))),
            }
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
        "capabilities.status" => {
            let pyright_ready = lsp::pyright_present();
            let tsc_ready = lsp::tsc_present();
            let joern_ready = joern::available();
            Ok(json!({
                "cpg": {
                    "available": joern_ready,
                    "reason": if joern_ready {
                        "Joern detected; full cross-file slice queries are still pending wiring"
                    } else {
                        joern::degraded_reason()
                    },
                },
                "slice": {
                    "available": true,
                    "reason": "intra-function AST slicing ready; cross-file needs CPG (workstream C)",
                },
                "pyright": {
                    "available": pyright_ready,
                    "reason": if pyright_ready { "ready" } else { "pyright not on PATH" },
                },
                "tsc": {
                    "available": tsc_ready,
                    "reason": if tsc_ready { "ready" } else { "tsc not on PATH (npm i -g typescript)" },
                },
                "rust-analyzer": {
                    "available": rust_analyzer::binary_present(),
                    "reason": if rust_analyzer::binary_present() { "ready" } else { rust_analyzer::degraded_reason() },
                },
                "semgrep": {
                    "available": semgrep::binary_present(),
                    "reason": if semgrep::binary_present() { "ready" } else { semgrep::degraded_reason() },
                },
                "pytea": {
                    "available": pytea::binary_present(),
                    "reason": if pytea::binary_present() { "ready" } else { pytea::degraded_reason() },
                },
                "llm": {
                    "available": std::env::var("ANTHROPIC_API_KEY").is_ok(),
                    "reason": if std::env::var("ANTHROPIC_API_KEY").is_ok() { "ready" } else { "ANTHROPIC_API_KEY not set" },
                },
            }))
        }
        "notes.post" => {
            let draft: crate::contracts::NoteDraft = serde_json::from_value(req.params.clone())
                .map_err(|e| RpcError::invalid_params(format!("{e}")))?;
            let note = handle_notes_post(draft, &state).await;
            broadcast_notes(&state, &ev_tx).await;
            Ok(serde_json::to_value(note).expect("serialise note"))
        }
        "notes.list" => {
            let w = state.workspace.read().await;
            Ok(serde_json::to_value(&w.notes).expect("serialise notes"))
        }
        "notes.resolve" => {
            let params: crate::contracts::NoteResolveRequest =
                serde_json::from_value(req.params.clone())
                    .map_err(|e| RpcError::invalid_params(format!("{e}")))?;
            let resolved = handle_notes_resolve(&params.id, &state).await;
            broadcast_notes(&state, &ev_tx).await;
            Ok(json!({ "resolved": resolved }))
        }
        "notes.clear" => {
            {
                let mut w = state.workspace.write().await;
                w.notes.clear();
            }
            broadcast_notes(&state, &ev_tx).await;
            Ok(Value::Null)
        }
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

async fn handle_slice_compute(
    req: SliceRequest,
    state: &SharedState,
    ev_tx: &mpsc::UnboundedSender<DaemonEvent>,
) -> Result<Value, RpcError> {
    // Cross-file slicing needs the CPG. When IVE_ENABLE_JOERN flips it on,
    // we try the Joern subprocess; otherwise degrade cleanly.
    if req.cross_file {
        if joern::slice_subprocess_enabled() {
            if let Some(slice) = joern::compute_cross_file_slice(&state.root, &req) {
                return Ok(serde_json::to_value(slice).expect("serialise joern slice"));
            }
        }
        let reason = "cross-file slicing needs the Code Property Graph (workstream C).";
        let _ = ev_tx.send(DaemonEvent::CapabilityDegraded {
            capability: "cpg".into(),
            reason: reason.into(),
        });
        return Err(RpcError {
            code: -32000,
            message: format!("{reason} {}", joern::degraded_reason()),
            data: Some(json!({"capability": "cpg"})),
        });
    }
    // Intra-function slicing: pull the file bytes + detect language.
    let abs = state.root.join(&req.origin.file);
    let Ok(bytes) = std::fs::read(&abs) else {
        return Err(RpcError::invalid_params(format!(
            "file not found: {}",
            req.origin.file
        )));
    };
    let Some(lang) = Language::from_path(&req.origin.file) else {
        return Err(RpcError::invalid_params(format!(
            "unsupported language for {}",
            req.origin.file
        )));
    };

    match slice::compute(&req, &bytes, lang) {
        slice::Outcome::Ok(s) => Ok(serde_json::to_value(s).expect("serialise slice")),
        slice::Outcome::NeedsCpg(reason) => {
            let _ = ev_tx.send(DaemonEvent::CapabilityDegraded {
                capability: "cpg".into(),
                reason: reason.into(),
            });
            Err(RpcError {
                code: -32000,
                message: format!("{reason} {}", joern::degraded_reason()),
                data: Some(json!({"capability": "cpg"})),
            })
        }
        slice::Outcome::NoEnclosingFunction => Err(RpcError {
            code: -32000,
            message: "no function encloses the cursor — slice requires an enclosing function"
                .into(),
            data: Some(json!({"capability": "cpg"})),
        }),
    }
}

async fn handle_notes_post(
    draft: crate::contracts::NoteDraft,
    state: &SharedState,
) -> crate::contracts::Note {
    let id = draft.id.unwrap_or_else(generate_note_id);
    let created_at = iso8601_now();
    let author = draft.author.unwrap_or(crate::contracts::NoteAuthor::Claude);
    let note = crate::contracts::Note {
        id,
        kind: draft.kind,
        title: draft.title,
        body: draft.body,
        location: draft.location,
        symbol: draft.symbol,
        severity: draft.severity,
        author,
        created_at,
        resolved_at: None,
    };
    {
        let mut w = state.workspace.write().await;
        // Replace if an existing note shares the same id; otherwise append.
        if let Some(pos) = w.notes.iter().position(|n| n.id == note.id) {
            w.notes[pos] = note.clone();
        } else {
            w.notes.push(note.clone());
        }
    }
    note
}

async fn handle_notes_resolve(id: &str, state: &SharedState) -> bool {
    let mut w = state.workspace.write().await;
    if let Some(pos) = w.notes.iter().position(|n| n.id == id) {
        w.notes.remove(pos);
        true
    } else {
        false
    }
}

async fn broadcast_notes(state: &SharedState, ev_tx: &mpsc::UnboundedSender<DaemonEvent>) {
    let w = state.workspace.read().await;
    let _ = ev_tx.send(DaemonEvent::NotesUpdated {
        notes: w.notes.clone(),
    });
}

fn generate_note_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("n-{nanos:x}")
}

fn iso8601_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = unix_to_ymdhms(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn unix_to_ymdhms(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400) as u32;
    let h = secs_of_day / 3600;
    let mi = (secs_of_day / 60) % 60;
    let s = secs_of_day % 60;
    let mut year: i64 = 1970;
    let mut days_left = days;
    loop {
        let y_days = if is_leap(year) { 366 } else { 365 };
        if days_left < y_days as i64 {
            break;
        }
        days_left -= y_days as i64;
        year += 1;
    }
    let months = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1u32;
    for (i, m) in months.iter().enumerate() {
        let dm = if i == 1 && is_leap(year) { 29 } else { *m };
        if days_left < dm as i64 {
            month = (i + 1) as u32;
            break;
        }
        days_left -= dm as i64;
    }
    (year, month, (days_left + 1) as u32, h, mi, s)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

async fn find_symbol_at(state: &SharedState, loc: &Location) -> Option<Location> {
    let w = state.workspace.read().await;
    let file = w.files.get(&loc.file)?;
    let (line, col) = (loc.range.start[0], loc.range.start[1]);
    let mut best: Option<&crate::parser::FunctionUnit> = None;
    for f in &file.functions {
        let r = &f.location.range;
        let inside = (r.start[0], r.start[1]) <= (line, col) && (r.end[0], r.end[1]) >= (line, col);
        if inside {
            best = match best {
                None => Some(f),
                Some(prev) => {
                    let prev_span = span_size(prev);
                    let cur_span = span_size(f);
                    if cur_span <= prev_span {
                        Some(f)
                    } else {
                        Some(prev)
                    }
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
    let Some(file) = w.files.get(&def.file) else {
        return vec![];
    };
    let Some(target) = file.functions.iter().find(|f| f.location == def) else {
        return vec![];
    };
    let leaf = target
        .name
        .rsplit('.')
        .next()
        .unwrap_or(&target.name)
        .to_string();
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
        let state =
            crate::state::State::new(std::env::temp_dir(), crate::config::Config::default());
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
        let state =
            crate::state::State::new(std::env::temp_dir(), crate::config::Config::default());
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
        let state =
            crate::state::State::new(std::env::temp_dir(), crate::config::Config::default());
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

    #[tokio::test]
    async fn notes_post_list_resolve_round_trip() {
        let state =
            crate::state::State::new(std::env::temp_dir(), crate::config::Config::default());
        let (tx, mut rx) = crate::events::channel();

        let post = RpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "notes.post".into(),
            params: json!({
                "kind": "concern",
                "title": "composite 0.82",
                "body": "fetch() is deeply nested and grew 40 LOC since last week",
                "location": {
                    "file": "services/slop.py",
                    "range": { "start": [5, 0], "end": [5, 0] }
                },
                "severity": "warning"
            }),
        };
        let v = dispatch_method(&post, Arc::clone(&state), tx.clone())
            .await
            .unwrap();
        let note: crate::contracts::Note = serde_json::from_value(v).unwrap();
        assert_eq!(note.title, "composite 0.82");
        assert_eq!(note.kind, crate::contracts::NoteKind::Concern);
        assert_eq!(note.author, crate::contracts::NoteAuthor::Claude);
        assert!(note.id.starts_with("n-"));

        // Event broadcast lands on the channel.
        let ev = rx.recv().await.expect("event");
        match ev {
            DaemonEvent::NotesUpdated { notes } => {
                assert_eq!(notes.len(), 1);
                assert_eq!(notes[0].id, note.id);
            }
            other => panic!("expected NotesUpdated, got {other:?}"),
        }

        let list = RpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(2)),
            method: "notes.list".into(),
            params: Value::Null,
        };
        let v = dispatch_method(&list, Arc::clone(&state), tx.clone())
            .await
            .unwrap();
        let notes: Vec<crate::contracts::Note> = serde_json::from_value(v).unwrap();
        assert_eq!(notes.len(), 1);

        let resolve = RpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(3)),
            method: "notes.resolve".into(),
            params: json!({ "id": note.id }),
        };
        let v = dispatch_method(&resolve, Arc::clone(&state), tx.clone())
            .await
            .unwrap();
        assert_eq!(v["resolved"], json!(true));

        let list = RpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(4)),
            method: "notes.list".into(),
            params: Value::Null,
        };
        let v = dispatch_method(&list, Arc::clone(&state), tx)
            .await
            .unwrap();
        let notes: Vec<crate::contracts::Note> = serde_json::from_value(v).unwrap();
        assert!(notes.is_empty(), "resolve should drop the note");
    }

    #[tokio::test]
    async fn notes_post_with_explicit_id_replaces_existing() {
        let state =
            crate::state::State::new(std::env::temp_dir(), crate::config::Config::default());
        let (tx, _rx) = crate::events::channel();
        let make = |title: &str| RpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "notes.post".into(),
            params: json!({
                "id": "pinned-1",
                "kind": "intent",
                "title": title,
                "body": "b",
            }),
        };
        dispatch_method(&make("first"), Arc::clone(&state), tx.clone())
            .await
            .unwrap();
        dispatch_method(&make("second"), Arc::clone(&state), tx.clone())
            .await
            .unwrap();
        let w = state.workspace.read().await;
        assert_eq!(w.notes.len(), 1);
        assert_eq!(w.notes[0].title, "second");
    }
}
