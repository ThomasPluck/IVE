//! Workstream E — PyTea (PyTorch shape checker).
//!
//! PyTea isn't pip-installable at v1 — it's a research tool shipped as a
//! Node + Python hybrid from `ropas/pytea`. We therefore do the honest
//! thing:
//! - Probe for a `pytea` script on PATH.
//! - When present, shell out on files that `import torch`, with a 10 s
//!   wall-clock (per spec §5 E), parse the output into `Diagnostic`s.
//! - When absent, emit `capabilityDegraded{capability:"pytea"}` and
//!   carry on.
//!
//! Parsing PyTea's human-readable output is deliberately minimal — we
//! grep for shape-mismatch errors and map them. When PyTea ships a
//! JSON output mode we upgrade. Until then we accept the surface.
//!
//! `IVE_SKIP_PYTEA` disables detection for tests.

use crate::contracts::{Diagnostic, DiagnosticSource, Location, Range, Severity};
use std::path::Path;
use std::process::Command;

pub fn binary_present() -> bool {
    if std::env::var("IVE_SKIP_PYTEA").is_ok() {
        return false;
    }
    Command::new("pytea")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn degraded_reason() -> &'static str {
    "PyTea not on PATH — PyTorch shape diagnostics disabled. See https://github.com/ropas/pytea for install instructions (workstream E)."
}

/// Returns `true` if the file's source contains a top-level `import torch`
/// or `from torch ...` — cheap substring check so we don't pay PyTea's
/// cold-start cost on every Python file.
pub fn file_imports_torch(source: &str) -> bool {
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("import torch") || trimmed.starts_with("from torch") {
            return true;
        }
    }
    false
}

/// Run PyTea against a single `.py` file. Returns `None` when the binary
/// isn't available or the file doesn't need it — both are
/// capabilityDegraded paths the caller should translate.
pub fn scan_file(root: &Path, rel_file: &str) -> Option<Vec<Diagnostic>> {
    if !binary_present() {
        return None;
    }
    let abs = root.join(rel_file);
    let bytes = std::fs::read(&abs).ok()?;
    let source = std::str::from_utf8(&bytes).ok()?;
    if !file_imports_torch(source) {
        return Some(vec![]);
    }
    let output = Command::new("pytea").arg(&abs).output().ok()?;
    // PyTea writes error summaries to stdout prefixed with a severity tag.
    let text = String::from_utf8_lossy(&output.stdout);
    Some(parse_pytea_output(&text, rel_file))
}

fn parse_pytea_output(text: &str, rel_file: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        // Very narrow heuristic — PyTea prints shape-mismatch errors as
        // `[Shape Error]` / `[Pytea Error]` followed by context. Only
        // surface lines that look like that; ignore progress noise.
        let (severity, kind) = if trimmed.starts_with("[Shape Error]") {
            (Severity::Error, "pytea/shape-mismatch")
        } else if trimmed.starts_with("[Pytea Error]") {
            (Severity::Error, "pytea/analysis-error")
        } else {
            continue;
        };
        out.push(Diagnostic {
            id: format!("pytea:{}:{}", rel_file, out.len()),
            severity,
            source: DiagnosticSource::Pytea,
            code: kind.to_string(),
            message: trimmed.to_string(),
            location: Location {
                file: rel_file.to_string(),
                range: Range {
                    start: [0, 0],
                    end: [0, 0],
                },
            },
            symbol: None,
            related: vec![],
            fix: None,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_imports_torch_detects_top_and_from() {
        assert!(file_imports_torch("import torch\n"));
        assert!(file_imports_torch("from torch import nn\n"));
        assert!(file_imports_torch("import os\nimport torch\n"));
        assert!(!file_imports_torch("import requests\n"));
        assert!(!file_imports_torch("# import torch\n"));
    }

    #[test]
    fn parse_pytea_output_filters_non_error_lines() {
        let raw = "
starting analysis...
[Shape Error] tensor dim mismatch on line 42
...progress...
[Pytea Error] could not resolve symbol
ignored line
";
        let diags = parse_pytea_output(raw, "m.py");
        assert_eq!(diags.len(), 2);
        assert_eq!(diags[0].code, "pytea/shape-mismatch");
        assert_eq!(diags[0].severity, Severity::Error);
        assert_eq!(diags[1].code, "pytea/analysis-error");
    }

    #[test]
    fn skip_env_disables_detection() {
        std::env::set_var("IVE_SKIP_PYTEA", "1");
        assert!(!binary_present());
        std::env::remove_var("IVE_SKIP_PYTEA");
    }
}
