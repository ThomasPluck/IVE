//! Shared daemon state.
//!
//! All RPC handlers read from `Workspace` via `&State`. Mutations are
//! serialised through `&mut Workspace` during scan/watch cycles.

use crate::analyzers::hallucination::LockfileIndex;
use crate::cache::BlobIndex;
use crate::config::Config;
use crate::contracts::{Diagnostic, HealthScore, SymbolId};
use crate::scanner::{ParseCache, ScannedFile};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Default)]
pub struct Workspace {
    pub files: HashMap<String, ScannedFile>,
    pub diagnostics: HashMap<String, Vec<Diagnostic>>,
    pub function_scores: HashMap<SymbolId, HealthScore>,
    pub file_scores: HashMap<String, HealthScore>,
    pub lockfiles: LockfileIndex,
}

pub struct State {
    pub root: PathBuf,
    pub config: Config,
    pub workspace: RwLock<Workspace>,
    pub blobs: BlobIndex,
    /// SHA-keyed parse-result cache — `spec §2` incremental reparse lite.
    pub parse_cache: ParseCache,
    pub capabilities: RwLock<Capabilities>,
}

#[derive(Debug, Clone, Default)]
pub struct Capabilities {
    pub cpg_available: bool,
    pub lsp_available: bool,
    pub semgrep_available: bool,
    pub llm_available: bool,
}

impl State {
    pub fn new(root: PathBuf, config: Config) -> Arc<Self> {
        Arc::new(Self {
            root,
            config,
            workspace: RwLock::new(Workspace::default()),
            blobs: BlobIndex::default(),
            parse_cache: ParseCache::default(),
            capabilities: RwLock::new(Capabilities::default()),
        })
    }
}

pub type SharedState = Arc<State>;
