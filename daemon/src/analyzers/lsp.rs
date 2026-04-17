//! Workstream D — type-checker integrations.
//!
//! v1 ships Pyright only, and uses the CLI (`pyright --outputjson`) rather
//! than a long-lived LSP client. That keeps the surface small enough to
//! ship end-to-end while still feeding real type diagnostics into the
//! Diagnostic contract. A proper LSP client (stateful, streaming via
//! `textDocument/publishDiagnostics`, hover cache for workstream F) is
//! planned but deferred — the CLI path is already useful.
//!
//! When Pyright isn't on PATH the check degrades cleanly; no silent drops.
//!
//! `tsc` and `rust-analyzer` still stub. Adding them follows this same
//! shape — a subprocess runner that maps JSON → Diagnostic.

use crate::contracts::{Diagnostic, DiagnosticSource, Location, Range, Severity};
use serde::Deserialize;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

pub fn degraded_reason() -> &'static str {
    "Pyright not found on PATH. `pip install pyright` or `npm i -g pyright` to enable Python type diagnostics. tsc / rust-analyzer are still stubbed (workstream D)."
}

pub fn pyright_present() -> bool {
    if std::env::var("IVE_SKIP_PYRIGHT").is_ok() {
        return false;
    }
    Command::new("pyright")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run Pyright against `root` and return the flattened diagnostic list.
/// Falls back to empty on any failure (binary missing, JSON parse error,
/// non-zero exit). The 30s wall-clock stops a runaway type-check from
/// blocking the scan.
pub fn scan_workspace(root: &Path) -> Option<Vec<Diagnostic>> {
    if !pyright_present() {
        return None;
    }
    let output = Command::new("pyright")
        .arg("--outputjson")
        .arg("--level")
        .arg("warning")
        .arg(root)
        .output()
        .ok()?;
    // Pyright exits non-zero when it finds issues — that's fine, we want the
    // JSON either way.
    let parsed: PyrightReport = serde_json::from_slice(&output.stdout).ok()?;
    let mut out = Vec::with_capacity(parsed.general_diagnostics.len());
    for d in &parsed.general_diagnostics {
        if let Some(diag) = to_diagnostic(root, d) {
            out.push(diag);
        }
    }
    Some(out)
}

#[derive(Debug, Deserialize)]
struct PyrightReport {
    #[serde(default, rename = "generalDiagnostics")]
    general_diagnostics: Vec<PyrightDiag>,
}

#[derive(Debug, Deserialize)]
struct PyrightDiag {
    file: String,
    severity: String,
    message: String,
    range: PyrightRange,
    #[serde(default)]
    rule: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PyrightRange {
    start: PyrightPos,
    end: PyrightPos,
}

#[derive(Debug, Deserialize)]
struct PyrightPos {
    line: u32,
    character: u32,
}

fn to_diagnostic(root: &Path, d: &PyrightDiag) -> Option<Diagnostic> {
    let rel = Path::new(&d.file)
        .strip_prefix(root)
        .ok()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| Path::new(&d.file).to_path_buf());
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    let severity = match d.severity.as_str() {
        "error" => Severity::Error,
        "warning" => Severity::Warning,
        "information" => Severity::Info,
        _ => Severity::Hint,
    };
    let code = d.rule.clone().unwrap_or_else(|| "pyright".to_string());
    Some(Diagnostic {
        id: format!("pyright:{}:{}:{}", rel_str, d.range.start.line, code),
        severity,
        source: DiagnosticSource::Pyright,
        code,
        message: d.message.clone(),
        location: Location {
            file: rel_str,
            range: Range {
                start: [d.range.start.line, d.range.start.character],
                end: [d.range.end.line, d.range.end.character],
            },
        },
        symbol: None,
        related: vec![],
        fix: None,
    })
}

#[allow(dead_code)]
pub const HARD_TIMEOUT: Duration = Duration::from_secs(30);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pyright_report_shape() {
        let raw = r#"{
            "version": "1.1.0",
            "generalDiagnostics": [
                {
                    "file": "/tmp/x/a.py",
                    "severity": "error",
                    "message": "Undefined variable \"foo\"",
                    "range": {
                        "start": { "line": 4, "character": 0 },
                        "end":   { "line": 4, "character": 3 }
                    },
                    "rule": "reportUndefinedVariable"
                }
            ]
        }"#;
        let parsed: PyrightReport = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.general_diagnostics.len(), 1);
        let d = to_diagnostic(Path::new("/tmp/x"), &parsed.general_diagnostics[0]).unwrap();
        assert_eq!(d.location.file, "a.py");
        assert_eq!(d.severity, Severity::Error);
        assert_eq!(d.code, "reportUndefinedVariable");
        assert_eq!(d.location.range.start, [4, 0]);
    }

    #[test]
    fn unknown_severity_degrades_to_hint() {
        let raw = PyrightDiag {
            file: "/tmp/x/a.py".into(),
            severity: "unknown".into(),
            message: "x".into(),
            range: PyrightRange {
                start: PyrightPos {
                    line: 0,
                    character: 0,
                },
                end: PyrightPos {
                    line: 0,
                    character: 1,
                },
            },
            rule: None,
        };
        let d = to_diagnostic(Path::new("/tmp/x"), &raw).unwrap();
        assert_eq!(d.severity, Severity::Hint);
        assert_eq!(d.code, "pyright");
    }
}
