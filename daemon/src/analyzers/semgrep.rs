//! Workstream E — Semgrep OSS + Python-specific analyzers (PyTea).
//!
//! Stub in v1. When the `semgrep` binary is on `PATH`, the daemon will shell
//! out on save with `--config rules/ive-ai-slop.yml --json` and fold the
//! results into the Diagnostic contract. Until then the capability reports
//! as degraded.

use std::process::Command;

pub fn binary_present() -> bool {
    Command::new("semgrep")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn degraded_reason() -> &'static str {
    "Semgrep binary not found on PATH and integration pending (workstream E). Install Semgrep OSS to enable these checks."
}
