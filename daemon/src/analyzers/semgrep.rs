//! Workstream E — Semgrep OSS runner.
//!
//! When `semgrep` is on PATH we shell out with `--config rules/ive-ai-slop.yml
//! --json --error-on-findings=false` and fold the JSON results into the
//! Diagnostic contract. Absence of the binary is reported as
//! `capabilityDegraded` rather than silently dropping results (§2).
//!
//! The rules file lives at the repository root. When the daemon is packaged,
//! workstream I should ship the rules inside the analyzer pack and set
//! `IVE_SEMGREP_RULES` to the installed path.

use crate::contracts::{Diagnostic, DiagnosticSource, Location, Range, Severity};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tracing::warn;

pub fn binary_present() -> bool {
    if std::env::var("IVE_SKIP_SEMGREP").is_ok() {
        return false;
    }
    Command::new("semgrep")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn degraded_reason() -> &'static str {
    "Semgrep binary not found on PATH. Install Semgrep OSS (`pipx install semgrep`) to enable these checks."
}

pub fn rules_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("IVE_SEMGREP_RULES") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    // dev-time default: rules/ at the Cargo workspace root.
    let manifest = env!("CARGO_MANIFEST_DIR");
    let candidate = PathBuf::from(manifest)
        .parent()?
        .join("rules")
        .join("ive-ai-slop.yml");
    if candidate.exists() {
        return Some(candidate);
    }
    None
}

/// Run Semgrep against a single file path (or the workspace root). Returns
/// `None` when the binary is absent so the caller can emit
/// `capabilityDegraded`. The 10s timeout shields us from a runaway scan.
pub fn scan_path(target: &Path, rules: &Path) -> Option<Vec<Diagnostic>> {
    if !binary_present() {
        return None;
    }
    // Semgrep ≥1.x exits non-zero when it finds issues — we consume
    // stdout either way and don't pass the flag that older versions used
    // for this (it was renamed/removed across versions).
    // `--no-git-ignore` is load-bearing: without it, semgrep auto-detects
    // when the target lives inside a git repo and silently restricts the
    // scan to files tracked by git from semgrep's own vantage point. That
    // produces 0 findings on subdirectory targets even when the files are
    // tracked at the repo root (the daemon's case). We never want that
    // behaviour — IVE owns workspace traversal — so always opt out.
    let output = Command::new("semgrep")
        .arg("--config")
        .arg(rules)
        .arg("--json")
        .arg("--timeout")
        .arg("10")
        .arg("--no-git-ignore")
        .arg(target)
        .output()
        .ok()?;
    let parsed: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(v) => v,
        Err(e) => {
            warn!(
                error = %e,
                stderr = %String::from_utf8_lossy(&output.stderr),
                "semgrep stdout was not valid JSON"
            );
            return None;
        }
    };
    let results = match parsed.get("results").and_then(|r| r.as_array()) {
        Some(r) => r,
        None => {
            warn!(
                stderr = %String::from_utf8_lossy(&output.stderr),
                "semgrep JSON had no `results` array"
            );
            return None;
        }
    };
    if results.is_empty() {
        // 0 findings is a legitimate outcome, but on the AI-slop fixtures
        // it's almost always a misconfig. Surface semgrep's own errors so
        // the failure is debuggable.
        let errors = parsed
            .get("errors")
            .map(|e| e.to_string())
            .unwrap_or_else(|| "[]".into());
        let stderr_tail = String::from_utf8_lossy(&output.stderr);
        warn!(
            errors = %errors,
            stderr_len = stderr_tail.len(),
            stderr_tail = %stderr_tail.lines().rev().take(5).collect::<Vec<_>>().join(" | "),
            "semgrep returned 0 results"
        );
    }
    let mut diagnostics = Vec::with_capacity(results.len());
    for r in results {
        if let Some(d) = result_to_diagnostic(r, target) {
            diagnostics.push(d);
        }
    }
    Some(diagnostics)
}

fn result_to_diagnostic(r: &serde_json::Value, target: &Path) -> Option<Diagnostic> {
    let raw_check_id = r.get("check_id")?.as_str()?;
    // Semgrep prefixes the check_id with the parent directory path,
    // e.g. `home.user.repo.rules.ive-ai-slop.eval-on-untyped-input`.
    // Keep only the last two components (`ive-ai-slop.<rule>`) so the code
    // stays stable regardless of install location.
    let check_id: String = {
        let parts: Vec<&str> = raw_check_id.split('.').collect();
        if parts.len() >= 2 {
            parts[parts.len() - 2..].join(".")
        } else {
            raw_check_id.to_string()
        }
    };
    let check_id = check_id.as_str();
    let path = r.get("path")?.as_str()?;
    let start = r.get("start")?;
    let end = r.get("end")?;
    let start_line = start.get("line")?.as_u64()?.saturating_sub(1) as u32;
    let start_col = start.get("col")?.as_u64()?.saturating_sub(1) as u32;
    let end_line = end.get("line")?.as_u64()?.saturating_sub(1) as u32;
    let end_col = end.get("col")?.as_u64()?.saturating_sub(1) as u32;
    let message = r
        .get("extra")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or(check_id)
        .to_string();
    let severity_str = r
        .get("extra")
        .and_then(|e| e.get("severity"))
        .and_then(|s| s.as_str())
        .unwrap_or("WARNING");
    let severity = match severity_str {
        "ERROR" => Severity::Error,
        "WARNING" => Severity::Warning,
        "INFO" => Severity::Info,
        _ => Severity::Warning,
    };
    let rel = Path::new(path)
        .strip_prefix(target)
        .unwrap_or(Path::new(path));
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    Some(Diagnostic {
        id: format!("semgrep:{}:{}:{}", rel_str, start_line, check_id),
        severity,
        source: DiagnosticSource::Semgrep,
        code: check_id.to_string(),
        message,
        location: Location {
            file: rel_str,
            range: Range {
                start: [start_line, start_col],
                end: [end_line, end_col],
            },
        },
        symbol: None,
        related: vec![],
        fix: None,
    })
}

// Kept for parity with the prior type. Currently unused — exposed in case a
// future caller wants to short-circuit based on version.
#[allow(dead_code)]
pub fn binary_version() -> Option<String> {
    let out = Command::new("semgrep").arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Some(s)
}

#[allow(dead_code)]
pub const HARD_TIMEOUT: Duration = Duration::from_secs(15);
