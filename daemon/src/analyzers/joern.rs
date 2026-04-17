//! Workstream C — Joern/CPG integration.
//!
//! This module is deliberately limited to **presence detection** today.
//! The full CPG query path (pysrc2cpg + jssrc2cpg + CPGQL slicing) is a
//! multi-week subsystem on its own; shipping a stub that claims to work
//! would violate `spec §0` rule 2 ("Silent when there's nothing to say"
//! applied in reverse — if the CPG isn't really wired, we say so). This
//! file therefore:
//!
//! - Probes the host for a JRE (`java -version`) and the Joern CLI
//!   (`joern --version`). If **both** are present, `capabilities.status`
//!   reports `cpg.available = true` and the UI stops nagging.
//! - Keeps a `NotReady` return type for `slice::compute` cross_file=true
//!   paths to fall back onto.
//!
//! When the full integration lands, the code that would spawn Joern
//! belongs inside `fn run_slice_query`. Contract: it must map CPGQL
//! results into `contracts::Slice` — same types every other slice
//! consumer already uses.
//!
//! The env var `IVE_SKIP_JOERN` disables detection so tests don't flap
//! based on what's installed on the CI runner.

use std::process::Command;

pub fn jre_present() -> bool {
    if std::env::var("IVE_SKIP_JOERN").is_ok() {
        return false;
    }
    Command::new("java")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn joern_present() -> bool {
    if std::env::var("IVE_SKIP_JOERN").is_ok() {
        return false;
    }
    Command::new("joern")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn available() -> bool {
    jre_present() && joern_present()
}

pub fn degraded_reason() -> &'static str {
    "Joern/CPG integration pending (workstream C). Install JRE 17+ and the Joern CLI for future cross-file slicing; `slice.compute` currently runs an intra-function AST slice only."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skip_env_disables_detection() {
        std::env::set_var("IVE_SKIP_JOERN", "1");
        assert!(!jre_present());
        assert!(!joern_present());
        assert!(!available());
        std::env::remove_var("IVE_SKIP_JOERN");
    }
}
