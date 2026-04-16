//! File-watcher skeleton. v1 keeps it synchronous-on-start; steady-state
//! debounced file events are handled by `notify-debouncer-full` in `main.rs`
//! via a lightweight callback to `rescan_one` on `state::SharedState`.
//!
//! For cold scans and manual rescan we simply iterate — the watcher is only
//! about delta updates.

use crate::analyzers::hallucination;
use crate::contracts::{DaemonEvent, Diagnostic};
use crate::events::EventTx;
use crate::health::{self, score_file};
use crate::scanner::{self, ScannedFile};
use crate::state::{SharedState, Workspace};
use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;
use tracing::{debug, info};

pub async fn rescan_workspace(state: &SharedState, tx: &EventTx) -> anyhow::Result<()> {
    let started = Instant::now();
    let paths: Vec<_> = scanner::walk_workspace(&state.root).collect();
    let total = paths.len() as u32;
    let _ = tx.send(DaemonEvent::IndexProgress {
        files_done: 0,
        files_total: total,
    });

    let lockfiles = hallucination::LockfileIndex::from_workspace(&state.root);

    let mut scanned_map: HashMap<String, ScannedFile> = HashMap::new();
    let mut done: u32 = 0;
    let mut cache_hits: u32 = 0;

    for path in &paths {
        done += 1;
        if let Ok(Some(sf)) = scanner::scan_file(&state.root, path) {
            let (changed, _sha) = state.blobs.update_if_changed(path.to_path_buf(), path_bytes(path).as_ref());
            if !changed {
                cache_hits += 1;
            }
            scanned_map.insert(sf.relative_path.clone(), sf);
        }
        if total > 0 && done % 50 == 0 {
            let _ = tx.send(DaemonEvent::IndexProgress {
                files_done: done,
                files_total: total,
            });
        }
    }

    let fan_in = health::build_fan_in(&scanned_map);

    let mut workspace = Workspace::default();
    workspace.lockfiles = lockfiles;

    let mut file_scores = Vec::new();

    for (_path, sf) in &scanned_map {
        let diagnostics = hallucination::check_file(sf, &workspace.lockfiles);
        let hallucinated = diagnostics.len() as u32;

        let mut fn_scores = Vec::with_capacity(sf.functions.len());
        for func in &sf.functions {
            let fi = fan_in.get(&func.symbol_id).copied().unwrap_or(0);
            let score = health::score_function(
                func,
                &state.config.health,
                fi,
                0,
                hallucinated,
                0,
                false,
            );
            workspace
                .function_scores
                .insert(func.symbol_id.clone(), score.clone());
            fn_scores.push(score);
        }

        let file_score = score_file(sf, &state.config.health, &fn_scores, diagnostics.len() as u32, hallucinated);
        workspace.file_scores.insert(sf.relative_path.clone(), file_score.clone());
        file_scores.push(file_score);

        workspace.diagnostics.insert(sf.relative_path.clone(), diagnostics.clone());
        let _ = tx.send(DaemonEvent::DiagnosticsUpdated {
            file: sf.relative_path.clone(),
            diagnostics,
        });
    }

    workspace.files = scanned_map;
    {
        let mut w = state.workspace.write().await;
        *w = workspace;
    }

    let _ = tx.send(DaemonEvent::IndexProgress {
        files_done: total,
        files_total: total,
    });

    let _ = tx.send(DaemonEvent::HealthUpdated { scores: file_scores });

    info!(
        elapsed_ms = started.elapsed().as_millis() as u64,
        files = total,
        cache_hits,
        "workspace scan complete"
    );
    Ok(())
}

fn path_bytes(p: &Path) -> Vec<u8> {
    std::fs::read(p).unwrap_or_default()
}

#[allow(dead_code)]
pub async fn rescan_one(state: &SharedState, tx: &EventTx, rel: &str) -> anyhow::Result<Vec<Diagnostic>> {
    let path = state.root.join(rel);
    let Some(sf) = scanner::scan_file(&state.root, &path)? else {
        return Ok(vec![]);
    };
    let diagnostics = {
        let w = state.workspace.read().await;
        hallucination::check_file(&sf, &w.lockfiles)
    };
    debug!(?rel, n = diagnostics.len(), "single-file rescan");

    {
        let mut w = state.workspace.write().await;
        w.diagnostics.insert(sf.relative_path.clone(), diagnostics.clone());
        w.files.insert(sf.relative_path.clone(), sf.clone());
    }
    let _ = tx.send(DaemonEvent::DiagnosticsUpdated {
        file: sf.relative_path.clone(),
        diagnostics: diagnostics.clone(),
    });
    Ok(diagnostics)
}
