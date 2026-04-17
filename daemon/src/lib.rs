//! IVE daemon library surface.
//!
//! The daemon orchestrates parsing, health scoring, and downstream analyzers,
//! and serves results over JSON-RPC per contracts in `spec §4`.
//!
//! Modules are organised along workstream boundaries so future agents can own
//! a single file without reading the rest.

pub mod analyzers;
pub mod cache;
pub mod config;
pub mod contracts;
pub mod events;
pub mod git;
pub mod health;
pub mod parser;
pub mod rpc;
pub mod scanner;
pub mod state;
pub mod watcher;
