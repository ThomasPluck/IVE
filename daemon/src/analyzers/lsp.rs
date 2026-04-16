//! Workstream D — LSP integrations (Pyright, tsc, rust-analyzer).
//!
//! Stub in v1. The plan:
//! - Spawn one LSP client per language per workspace
//! - Stream `publishDiagnostics` into the Diagnostic contract
//! - Cache `hover` responses for workstream F cross-file mismatches
//! - Fall back gracefully when binaries are missing

pub fn degraded_reason() -> &'static str {
    "LSP integrations (Pyright, tsc, rust-analyzer) not yet available (workstream D)."
}
