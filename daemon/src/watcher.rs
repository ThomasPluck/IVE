//! File-watcher skeleton. v1 keeps it synchronous-on-start; steady-state
//! debounced file events are handled by `notify-debouncer-full` in `main.rs`
//! via a lightweight callback to `rescan_one` on `state::SharedState`.
//!
//! For cold scans and manual rescan we simply iterate — the watcher is only
//! about delta updates.

use crate::analyzers::{binding, crossfile, hallucination, semgrep};
use crate::cache::DiskCache;
use crate::contracts::{DaemonEvent, Diagnostic};
use crate::events::EventTx;
use crate::git;
use crate::health::{self, score_file};
use crate::scanner::{self, ScannedFile};
use crate::state::{SharedState, Workspace};
use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;
use tracing::{debug, info};

pub async fn rescan_workspace(state: &SharedState, tx: &EventTx) -> anyhow::Result<()> {
    let started = Instant::now();

    // Hydrate the blob index from disk so first-scan-after-restart can count
    // cache hits on unchanged files.
    let disk_cache = DiskCache::new(&state.root, env!("CARGO_PKG_VERSION"));
    let mut manifest = disk_cache.load_manifest();
    {
        let snap = manifest
            .blobs
            .iter()
            .map(|(p, sha)| (state.root.join(p), sha.clone()))
            .collect();
        state.blobs.load_snapshot(snap);
    }

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
            let (changed, _sha) = state
                .blobs
                .update_if_changed(path.to_path_buf(), path_bytes(path).as_ref());
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
    let def_index = crossfile::build_def_index(&state.root, &scanned_map);
    let local_modules = hallucination::LocalModules::from_workspace(&state.root);
    let shader_syms = binding::ShaderSymbols::from_workspace(&state.root);
    let churn = git::collect_churn(&state.root, 14);

    // Workspace-wide Semgrep pass (optional; degrades cleanly if absent).
    let semgrep_diagnostics = if let Some(rules) = semgrep::rules_path() {
        match semgrep::scan_path(&state.root, &rules) {
            Some(diags) => {
                info!(n = diags.len(), "semgrep pass complete");
                diags
            }
            None => {
                let _ = tx.send(DaemonEvent::CapabilityDegraded {
                    capability: "semgrep".into(),
                    reason: semgrep::degraded_reason().into(),
                });
                vec![]
            }
        }
    } else {
        vec![]
    };

    let mut workspace = Workspace::default();
    workspace.lockfiles = lockfiles;

    let mut file_scores = Vec::new();

    for (_path, sf) in &scanned_map {
        let mut diagnostics = hallucination::check_file(sf, &workspace.lockfiles, &local_modules);
        let hallucinated = diagnostics.len() as u32;

        // Cross-file arity + WebGL binding check: both need the file
        // bytes, so we re-read once.
        if let Ok(bytes) = std::fs::read(state.root.join(&sf.relative_path)) {
            diagnostics.extend(crossfile::check(sf, &bytes, &def_index));
            diagnostics.extend(binding::check(sf, &bytes, &shader_syms));
        }

        // Semgrep diagnostics for this file, filtered from the workspace run.
        diagnostics.extend(
            semgrep_diagnostics
                .iter()
                .filter(|d| d.location.file == sf.relative_path)
                .cloned(),
        );

        let file_churn = churn.get(&sf.relative_path).copied().unwrap_or(0);
        let mut fn_scores = Vec::with_capacity(sf.functions.len());
        for func in &sf.functions {
            let fi = fan_in.get(&func.symbol_id).copied().unwrap_or(0);
            let score = health::score_function(
                func,
                &state.config.health,
                fi,
                0,
                hallucinated,
                file_churn,
                false,
            );
            workspace
                .function_scores
                .insert(func.symbol_id.clone(), score.clone());
            fn_scores.push(score);
        }

        let err_count = diagnostics
            .iter()
            .filter(|d| {
                matches!(
                    d.severity,
                    crate::contracts::Severity::Error | crate::contracts::Severity::Critical
                )
            })
            .count() as u32;
        let file_score = score_file(
            sf,
            &state.config.health,
            &fn_scores,
            diagnostics.len() as u32,
            hallucinated,
            err_count,
        );
        workspace
            .file_scores
            .insert(sf.relative_path.clone(), file_score.clone());
        file_scores.push(file_score);

        workspace
            .diagnostics
            .insert(sf.relative_path.clone(), diagnostics.clone());
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

    let _ = tx.send(DaemonEvent::HealthUpdated {
        scores: file_scores,
    });

    // Persist the blob index so the next startup can count hits.
    manifest.blobs = state
        .blobs
        .snapshot()
        .into_iter()
        .filter_map(|(abs, sha)| {
            abs.strip_prefix(&state.root)
                .ok()
                .map(|rel| (rel.to_string_lossy().replace('\\', "/"), sha))
        })
        .collect();
    disk_cache.prune(&mut manifest);
    if let Err(e) = disk_cache.save_manifest(&manifest) {
        debug!(error = %e, "failed to persist cache manifest");
    }

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

/// Spawn a background task that watches `state.root` for file changes and
/// triggers `rescan_one` after a short debounce. Dropping the returned
/// handle (via `std::mem::drop`) terminates the watcher.
pub fn spawn(state: SharedState, tx: EventTx) -> anyhow::Result<WatchHandle> {
    use notify::{EventKind, RecursiveMode};
    use notify_debouncer_full::{new_debouncer, DebouncedEvent};

    let root = state.root.clone();
    let (raw_tx, raw_rx) =
        std::sync::mpsc::channel::<Result<Vec<DebouncedEvent>, Vec<notify::Error>>>();
    let mut debouncer = new_debouncer(std::time::Duration::from_millis(150), None, move |res| {
        let _ = raw_tx.send(res);
    })?;
    debouncer.watch(&root, RecursiveMode::Recursive)?;

    // Move the raw receiver into a blocking thread (notify-debouncer-full
    // uses std::sync::mpsc, not an async channel) and forward relevant events
    // onto a tokio channel.
    let (async_tx, mut async_rx) = tokio::sync::mpsc::unbounded_channel::<std::path::PathBuf>();
    let root_for_thread = state.root.clone();
    std::thread::spawn(move || {
        while let Ok(res) = raw_rx.recv() {
            let Ok(events) = res else { continue };
            for evt in events {
                if !matches!(
                    evt.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                ) {
                    continue;
                }
                for path in &evt.paths {
                    if let Ok(rel) = path.strip_prefix(&root_for_thread) {
                        let s = rel.to_string_lossy();
                        if s.starts_with(".ive")
                            || s.contains("/.git/")
                            || s.contains("node_modules")
                        {
                            continue;
                        }
                        let _ = async_tx.send(path.clone());
                    }
                }
            }
        }
    });

    let worker = tokio::spawn(async move {
        while let Some(path) = async_rx.recv().await {
            let rel = match path.strip_prefix(&state.root) {
                Ok(p) => p.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            if crate::parser::Language::from_path(&rel).is_none() {
                continue;
            }
            if let Err(e) = rescan_one(&state, &tx, &rel).await {
                tracing::debug!(error = %e, rel = %rel, "incremental rescan failed");
            }
        }
    });

    Ok(WatchHandle {
        _debouncer: Box::new(debouncer),
        _worker: worker,
    })
}

pub struct WatchHandle {
    _debouncer: Box<dyn std::any::Any + Send>,
    _worker: tokio::task::JoinHandle<()>,
}

#[allow(dead_code)]
pub async fn rescan_one(
    state: &SharedState,
    tx: &EventTx,
    rel: &str,
) -> anyhow::Result<Vec<Diagnostic>> {
    let path = state.root.join(rel);
    let Some(sf) = scanner::scan_file(&state.root, &path)? else {
        return Ok(vec![]);
    };
    let local_modules = hallucination::LocalModules::from_workspace(&state.root);
    let diagnostics = {
        let w = state.workspace.read().await;
        hallucination::check_file(&sf, &w.lockfiles, &local_modules)
    };
    debug!(?rel, n = diagnostics.len(), "single-file rescan");

    {
        let mut w = state.workspace.write().await;
        w.diagnostics
            .insert(sf.relative_path.clone(), diagnostics.clone());
        w.files.insert(sf.relative_path.clone(), sf.clone());
    }
    let _ = tx.send(DaemonEvent::DiagnosticsUpdated {
        file: sf.relative_path.clone(),
        diagnostics: diagnostics.clone(),
    });
    Ok(diagnostics)
}
