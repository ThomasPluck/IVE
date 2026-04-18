//! Workstream D — type-checker integrations.
//!
//! v1 ships Pyright and tsc, both via CLI subprocess rather than long-lived
//! LSP clients. That keeps the surface small enough to ship end-to-end
//! while still feeding real type diagnostics into the Diagnostic contract.
//! A proper stateful LSP client (with hover cache feeding workstream F) is
//! planned but deferred — the CLI path is already useful.
//!
//! When a binary isn't on PATH or a project file is missing, the check
//! degrades cleanly; no silent drops.
//!
//! `rust-analyzer` still stubs — it has no CLI mode, so we either wire a
//! full LSP client or skip it. Deferred.

use crate::contracts::{Diagnostic, DiagnosticSource, Location, Range, Severity};
use regex::Regex;
use serde::Deserialize;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

pub fn degraded_reason() -> &'static str {
    "Pyright / tsc not found on PATH (or no tsconfig/pyproject present). `pip install pyright`, `npm i -g typescript` to enable type diagnostics. rust-analyzer is still stubbed (workstream D)."
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

// ─── tsc ────────────────────────────────────────────────────────────

pub fn tsc_present() -> bool {
    if std::env::var("IVE_SKIP_TSC").is_ok() {
        return false;
    }
    Command::new("tsc")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn has_tsconfig(root: &Path) -> bool {
    root.join("tsconfig.json").exists()
}

/// Run `tsc --noEmit --pretty false` against the workspace. Returns `None`
/// when tsc isn't available or there's no tsconfig.json (without a project
/// file tsc can't make sense of the source, and shelling out would force-
/// error on every run).
pub fn scan_typescript(root: &Path) -> Option<Vec<Diagnostic>> {
    if !tsc_present() || !has_tsconfig(root) {
        return None;
    }
    let output = Command::new("tsc")
        .arg("--noEmit")
        .arg("--pretty")
        .arg("false")
        .arg("--incremental")
        .arg("false")
        .current_dir(root)
        .output()
        .ok()?;

    // tsc writes errors to stdout in `--pretty false` mode (yes, stdout).
    let text = String::from_utf8_lossy(&output.stdout);
    let mut out = Vec::new();
    for line in text.lines() {
        if let Some(d) = parse_tsc_line(line, root) {
            out.push(d);
        }
    }
    Some(out)
}

fn parse_tsc_line(line: &str, root: &Path) -> Option<Diagnostic> {
    // Format: `path/to/file.ts(line,col): severity TScode: message`
    // Severity is either `error` or `warning` depending on tsconfig.
    static ONCE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = ONCE.get_or_init(|| {
        Regex::new(r"^(?P<file>[^()]+)\((?P<line>\d+),(?P<col>\d+)\): (?P<sev>error|warning) (?P<code>TS\d+): (?P<msg>.+)$")
            .unwrap()
    });
    let caps = re.captures(line.trim())?;
    let file = &caps["file"];
    let line_n: u32 = caps["line"].parse().ok()?;
    let col_n: u32 = caps["col"].parse().ok()?;
    let sev = &caps["sev"];
    let code = &caps["code"];
    let msg = &caps["msg"];

    // Normalise to workspace-relative POSIX.
    let abs = if Path::new(file).is_absolute() {
        std::path::PathBuf::from(file)
    } else {
        root.join(file)
    };
    let rel = abs.strip_prefix(root).unwrap_or(abs.as_path());
    let rel_str = rel.to_string_lossy().replace('\\', "/");

    let severity = match sev {
        "error" => Severity::Error,
        "warning" => Severity::Warning,
        _ => Severity::Info,
    };

    // tsc reports 1-based; contract is 0-based.
    let l0 = line_n.saturating_sub(1);
    let c0 = col_n.saturating_sub(1);

    Some(Diagnostic {
        id: format!("tsc:{}:{}:{}", rel_str, l0, code),
        severity,
        source: DiagnosticSource::Tsc,
        code: code.to_string(),
        message: msg.to_string(),
        location: Location {
            file: rel_str,
            range: Range {
                start: [l0, c0],
                end: [l0, c0],
            },
        },
        symbol: None,
        related: vec![],
        fix: None,
    })
}

#[cfg(test)]
mod tsc_tests {
    use super::*;

    #[test]
    fn parses_standard_tsc_error_line() {
        let line =
            "src/a.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.";
        let d = parse_tsc_line(line, Path::new("/ws")).unwrap();
        assert_eq!(d.code, "TS2322");
        assert_eq!(d.severity, Severity::Error);
        assert_eq!(d.location.file, "src/a.ts");
        assert_eq!(d.location.range.start, [11, 2]);
        assert!(d.message.contains("not assignable"));
    }

    #[test]
    fn parses_warning_line() {
        let line = "x.ts(1,1): warning TS6133: 'y' is declared but its value is never read.";
        let d = parse_tsc_line(line, Path::new("/ws")).unwrap();
        assert_eq!(d.severity, Severity::Warning);
    }

    #[test]
    fn ignores_non_diagnostic_lines() {
        assert!(parse_tsc_line("Found 2 errors in 1 file.", Path::new("/ws")).is_none());
        assert!(parse_tsc_line("", Path::new("/ws")).is_none());
    }

    #[test]
    fn absolute_paths_get_normalised_to_relative() {
        let line = "/ws/src/a.ts(1,1): error TS1: msg";
        let d = parse_tsc_line(line, Path::new("/ws")).unwrap();
        assert_eq!(d.location.file, "src/a.ts");
    }
}

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
