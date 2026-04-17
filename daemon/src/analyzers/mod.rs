//! Downstream analyzer integrations.
//!
//! Workstream boundaries (`spec §5`):
//! - `hallucination` — workstream F (IVE-native check, fully implemented in v1)
//! - `joern`         — workstream C (stub: returns `capabilityDegraded`)
//! - `lsp`           — workstream D (stub)
//! - `semgrep`       — workstream E (stub)
//! - `grounding`     — workstream G (stub)

pub mod binding;
pub mod crossfile;
pub mod grounding;
pub mod hallucination;
pub mod joern;
pub mod lsp;
pub mod semgrep;
pub mod slice;
