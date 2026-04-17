//! Minimal LSP client for `rust-analyzer` (workstream D, spec §5 D).
//!
//! This is NOT a general-purpose LSP client — it's the narrowest surface
//! that feeds `textDocument/publishDiagnostics` into the Diagnostic
//! contract. The flow:
//!
//! 1. Spawn `rust-analyzer` on stdio.
//! 2. Send `initialize` with the workspace rootUri.
//! 3. Await the response.
//! 4. Send `initialized`.
//! 5. `textDocument/didOpen` every `.rs` file under the root.
//! 6. Pump incoming messages for a settle window; collect every
//!    `publishDiagnostics` that arrives.
//! 7. Send `shutdown` + `exit` and reap the child.
//!
//! `IVE_SKIP_RUST_ANALYZER` disables detection so tests that don't want
//! to spin up the full LSP cost (~10 s per cargo check) can skip cleanly.

use crate::contracts::{Diagnostic, DiagnosticSource, Location, Range, Severity};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

pub fn binary_present() -> bool {
    if std::env::var("IVE_SKIP_RUST_ANALYZER").is_ok() {
        return false;
    }
    Command::new("rust-analyzer")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn degraded_reason() -> &'static str {
    "rust-analyzer not on PATH. `rustup component add rust-analyzer` to enable Rust type diagnostics (workstream D)."
}

/// Runs rust-analyzer against `root` and returns the flattened diagnostic
/// list, or `None` when the binary isn't available.
///
/// The `settle` duration is how long we pump after `initialized` before
/// shutting down. rust-analyzer's cargo-check pass can take several
/// seconds on first run; callers pick a budget that fits their UI
/// deadline.
pub fn scan_workspace(root: &Path, settle: Duration) -> Option<Vec<Diagnostic>> {
    if !binary_present() {
        return None;
    }
    let mut child = Command::new("rust-analyzer")
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;

    let result = drive(stdin, stdout, root, settle);
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn drive(
    stdin: ChildStdin,
    stdout: ChildStdout,
    root: &Path,
    settle: Duration,
) -> Option<Vec<Diagnostic>> {
    let (tx, rx) = mpsc::channel::<Message>();
    let reader_handle = spawn_reader(stdout, tx);
    let mut writer = stdin;

    // Step 1: initialize.
    let init_id: i64 = 1;
    let init_params = json!({
        "processId": std::process::id(),
        "clientInfo": { "name": "ive-daemon", "version": env!("CARGO_PKG_VERSION") },
        "rootUri": path_to_uri(root),
        "capabilities": {
            "textDocument": {
                "publishDiagnostics": {
                    "relatedInformation": true,
                    "versionSupport": false,
                },
                "synchronization": { "dynamicRegistration": false },
            },
            "workspace": { "workspaceFolders": true },
        },
        "workspaceFolders": [{
            "uri": path_to_uri(root),
            "name": root.file_name().and_then(|s| s.to_str()).unwrap_or("workspace"),
        }],
    });
    write_request(&mut writer, init_id, "initialize", &init_params).ok()?;

    // Wait for the initialize response.
    let init_deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match rx.recv_timeout(init_deadline.saturating_duration_since(Instant::now())) {
            Ok(Message::Response { id, .. }) if id == Some(init_id) => break,
            Ok(Message::Response { .. }) | Ok(Message::Notification { .. }) => continue,
            Ok(Message::Error(_)) | Err(_) => {
                let _ = reader_handle.join();
                return None;
            }
        }
    }

    // Step 2: initialized.
    write_notification(&mut writer, "initialized", &json!({})).ok()?;

    // Step 3: open every .rs file. rust-analyzer discovers workspace files
    // itself from Cargo.toml, but sending didOpen ensures diagnostics fire
    // for the files we care about even if some aren't in the build plan.
    for path in walk_rust_files(root) {
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let params = json!({
            "textDocument": {
                "uri": path_to_uri(&path),
                "languageId": "rust",
                "version": 1,
                "text": text,
            }
        });
        if write_notification(&mut writer, "textDocument/didOpen", &params).is_err() {
            break;
        }
    }

    // Step 4: pump diagnostics for the settle window.
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let deadline = Instant::now() + settle;
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(Message::Notification { method, params }) => {
                if method == "textDocument/publishDiagnostics" {
                    if let Some(entries) = parse_publish_diagnostics(&params, root) {
                        diagnostics.extend(entries);
                    }
                }
            }
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => break,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // Step 5: shutdown + exit. We ignore failures — if the child is wedged
    // the caller has already pulled what it can.
    let _ = write_request(&mut writer, 2, "shutdown", &json!(null));
    let _ = write_notification(&mut writer, "exit", &json!(null));
    drop(writer);
    let _ = reader_handle.join();

    // rust-analyzer re-publishes with fresh diagnostics; later events win.
    // Dedup by (file, line, code).
    dedup_latest(&mut diagnostics);
    Some(diagnostics)
}

enum Message {
    Response {
        id: Option<i64>,
        #[allow(dead_code)]
        result: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    #[allow(dead_code)]
    Error(String),
}

fn spawn_reader(stdout: ChildStdout, tx: mpsc::Sender<Message>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_frame(&mut reader) {
                Ok(Some(frame)) => {
                    let Ok(value): Result<Value, _> = serde_json::from_slice(&frame) else {
                        continue;
                    };
                    if let Some(id) = value.get("id").and_then(|v| v.as_i64()) {
                        let result = value.get("result").cloned().unwrap_or(Value::Null);
                        let _ = tx.send(Message::Response {
                            id: Some(id),
                            result,
                        });
                    } else if let Some(method) = value.get("method").and_then(|v| v.as_str()) {
                        let params = value.get("params").cloned().unwrap_or(Value::Null);
                        let _ = tx.send(Message::Notification {
                            method: method.to_string(),
                            params,
                        });
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = tx.send(Message::Error(e.to_string()));
                    break;
                }
            }
        }
    })
}

fn read_frame<R: BufRead>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>> {
    // LSP framing: Content-Length: N\r\n\r\n<body>
    let mut content_length: Option<usize> = None;
    loop {
        let mut header = String::new();
        let n = reader.read_line(&mut header)?;
        if n == 0 {
            return Ok(None);
        }
        let trimmed = header.trim_end_matches(&['\r', '\n'][..]);
        if trimmed.is_empty() {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
            content_length = rest.trim().parse().ok();
        }
    }
    let Some(n) = content_length else {
        return Ok(None);
    };
    let mut body = vec![0u8; n];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

fn write_request(w: &mut ChildStdin, id: i64, method: &str, params: &Value) -> std::io::Result<()> {
    let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    write_frame(w, &body)
}

fn write_notification(w: &mut ChildStdin, method: &str, params: &Value) -> std::io::Result<()> {
    let body = json!({ "jsonrpc": "2.0", "method": method, "params": params });
    write_frame(w, &body)
}

fn write_frame(w: &mut ChildStdin, body: &Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(body)?;
    w.write_all(format!("Content-Length: {}\r\n\r\n", bytes.len()).as_bytes())?;
    w.write_all(&bytes)?;
    w.flush()
}

fn walk_rust_files(root: &Path) -> Vec<PathBuf> {
    use ignore::WalkBuilder;
    let mut out = Vec::new();
    for entry in WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .require_git(false)
        .build()
        .flatten()
    {
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            let p = entry.into_path();
            if p.extension().and_then(|e| e.to_str()) == Some("rs") {
                out.push(p);
            }
        }
    }
    out
}

fn path_to_uri(p: &Path) -> String {
    let abs = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let raw = abs.to_string_lossy();
    let encoded = raw
        .chars()
        .map(|c| {
            if c == '\\' {
                "/".to_string()
            } else if c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.' | '~' | ':') {
                c.to_string()
            } else {
                format!("%{:02X}", c as u8)
            }
        })
        .collect::<String>();
    if encoded.starts_with('/') {
        format!("file://{}", encoded)
    } else {
        format!("file:///{}", encoded)
    }
}

fn uri_to_relative(uri: &str, root: &Path) -> Option<String> {
    let path = uri.strip_prefix("file://")?;
    let canon_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let root_str = canon_root.to_string_lossy();
    let stripped = if path.starts_with(root_str.as_ref()) {
        &path[root_str.len()..]
    } else {
        path
    };
    Some(stripped.trim_start_matches('/').replace('\\', "/"))
}

#[derive(Debug, Deserialize)]
struct RaPublish {
    uri: String,
    diagnostics: Vec<RaDiag>,
}

#[derive(Debug, Deserialize)]
struct RaDiag {
    range: RaRange,
    #[serde(default)]
    severity: Option<u8>,
    #[serde(default)]
    code: Option<Value>,
    message: String,
    #[serde(default)]
    source: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RaRange {
    start: RaPos,
    end: RaPos,
}

#[derive(Debug, Deserialize)]
struct RaPos {
    line: u32,
    character: u32,
}

fn parse_publish_diagnostics(params: &Value, root: &Path) -> Option<Vec<Diagnostic>> {
    let parsed: RaPublish = serde_json::from_value(params.clone()).ok()?;
    let rel = uri_to_relative(&parsed.uri, root)?;
    let mut out = Vec::with_capacity(parsed.diagnostics.len());
    for d in &parsed.diagnostics {
        let severity = match d.severity.unwrap_or(1) {
            1 => Severity::Error,
            2 => Severity::Warning,
            3 => Severity::Info,
            _ => Severity::Hint,
        };
        let code = d
            .code
            .as_ref()
            .and_then(|c| {
                c.as_str()
                    .map(str::to_string)
                    .or_else(|| c.get("value").and_then(|v| v.as_str()).map(str::to_string))
            })
            .unwrap_or_else(|| d.source.clone().unwrap_or_else(|| "rust-analyzer".into()));
        out.push(Diagnostic {
            id: format!("rust-analyzer:{}:{}:{}", rel, d.range.start.line, code),
            severity,
            source: DiagnosticSource::RustAnalyzer,
            code,
            message: d.message.clone(),
            location: Location {
                file: rel.clone(),
                range: Range {
                    start: [d.range.start.line, d.range.start.character],
                    end: [d.range.end.line, d.range.end.character],
                },
            },
            symbol: None,
            related: vec![],
            fix: None,
        });
    }
    Some(out)
}

fn dedup_latest(diags: &mut Vec<Diagnostic>) {
    // Keep the last occurrence of each (file, line, code) — publish events
    // supersede earlier ones for the same file.
    let mut keep: std::collections::HashMap<(String, u32, String), usize> =
        std::collections::HashMap::new();
    for (i, d) in diags.iter().enumerate() {
        keep.insert(
            (
                d.location.file.clone(),
                d.location.range.start[0],
                d.code.clone(),
            ),
            i,
        );
    }
    let mut indices: Vec<usize> = keep.into_values().collect();
    indices.sort_unstable();
    let mut idx_iter = indices.iter().peekable();
    let mut kept = Vec::with_capacity(indices.len());
    for (i, d) in diags.drain(..).enumerate() {
        if idx_iter.peek().copied() == Some(&i) {
            kept.push(d);
            idx_iter.next();
        }
    }
    *diags = kept;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_to_uri_round_trips_through_uri_to_relative() {
        let tmp = std::env::temp_dir().join("ive-lsp-uri-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("sub").join("a.rs");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "fn main() {}").unwrap();
        let uri = path_to_uri(&file);
        assert!(uri.starts_with("file://"));
        let rel = uri_to_relative(&uri, &tmp).unwrap();
        assert_eq!(rel, "sub/a.rs");
        std::fs::remove_dir_all(tmp).ok();
    }

    #[test]
    fn parse_publish_diagnostics_maps_severity_and_code() {
        let params = json!({
            "uri": "file:///tmp/ra-test/src/lib.rs",
            "diagnostics": [
                {
                    "range": { "start": {"line": 2, "character": 4}, "end": {"line": 2, "character": 9} },
                    "severity": 1,
                    "code": "E0277",
                    "message": "the trait bound Foo is not satisfied",
                    "source": "rustc"
                },
                {
                    "range": { "start": {"line": 5, "character": 0}, "end": {"line": 5, "character": 3} },
                    "severity": 2,
                    "code": { "target": "...", "value": "unused_variables" },
                    "message": "unused variable: x",
                    "source": "rustc"
                }
            ]
        });
        let tmp = std::env::temp_dir().join("ra-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let out = parse_publish_diagnostics(&params, &tmp).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].severity, Severity::Error);
        assert_eq!(out[0].code, "E0277");
        assert_eq!(out[1].severity, Severity::Warning);
        assert_eq!(out[1].code, "unused_variables");
        std::fs::remove_dir_all(tmp).ok();
    }

    #[test]
    fn dedup_latest_wins() {
        let mk = |msg: &str, line: u32| Diagnostic {
            id: "x".into(),
            severity: Severity::Error,
            source: DiagnosticSource::RustAnalyzer,
            code: "E0001".into(),
            message: msg.into(),
            location: Location {
                file: "a.rs".into(),
                range: Range {
                    start: [line, 0],
                    end: [line, 1],
                },
            },
            symbol: None,
            related: vec![],
            fix: None,
        };
        let mut v = vec![mk("first", 0), mk("second", 0), mk("other", 1)];
        dedup_latest(&mut v);
        assert_eq!(v.len(), 2);
        // Last write for (a.rs, 0, E0001) wins.
        assert_eq!(v[0].message, "second");
        assert_eq!(v[1].message, "other");
    }

    #[test]
    fn skip_env_disables_detection() {
        std::env::set_var("IVE_SKIP_RUST_ANALYZER", "1");
        assert!(!binary_present());
        std::env::remove_var("IVE_SKIP_RUST_ANALYZER");
    }
}
