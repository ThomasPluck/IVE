//! Workstream C — Joern/CPG integration.
//!
//! Stub in v1. The daemon spawns no JVM yet; the `slice.compute` RPC and
//! any CPG-dependent queries surface a `capabilityDegraded` event on first
//! use and return `NotReady`.
//!
//! When this workstream lands, replace `Status::NotReady` handling in
//! `rpc::handle_slice_compute` with real Joern client calls.

use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    NotReady,
}

#[derive(Debug, Error)]
pub enum JoernError {
    #[error("Joern integration not yet available (workstream C).")]
    NotReady,
}

pub fn status() -> Status {
    Status::NotReady
}

pub fn degraded_reason() -> &'static str {
    "JRE not detected and/or Joern subprocess not yet integrated. Slicing and cross-file CPG queries are disabled. Install JRE 17+ and wait for workstream C to land."
}
