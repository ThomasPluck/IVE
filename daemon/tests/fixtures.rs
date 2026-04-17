//! End-to-end fixture test — runs the daemon's `rescan_workspace` against
//! the sidecars in `test/fixtures/ai-slop/` and asserts the invariants each
//! YAML documents. Failures here should block a PR.

use ive_daemon::{config::Config, events, state::State, watcher};
use std::path::PathBuf;
use std::sync::Arc;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

async fn scan(workspace: PathBuf) -> Arc<State> {
    let config = Config::load(&workspace).unwrap();
    let state = State::new(workspace.canonicalize().unwrap(), config);
    let (tx, mut rx) = events::channel();
    let s = Arc::clone(&state);
    let task = tokio::spawn(async move { watcher::rescan_workspace(&s, &tx).await });
    while rx.recv().await.is_some() {}
    task.await.unwrap().unwrap();
    state
}

#[tokio::test]
async fn python_hallucinated_fixture_flags_hf_utils_and_pushes_file_out_of_green() {
    let dir = repo_root().join("test/fixtures/ai-slop/python");
    let state = scan(dir).await;
    let w = state.workspace.read().await;
    let diags = w.diagnostics.get("hallucinated.py").expect("file indexed");
    assert!(
        diags
            .iter()
            .any(|d| d.message.contains("huggingface_utils")),
        "expected a diagnostic about huggingface_utils, got: {:?}",
        diags.iter().map(|d| &d.message).collect::<Vec<_>>()
    );
    let score = w.file_scores.get("hallucinated.py").expect("file scored");
    assert!(
        !matches!(score.bucket, ive_daemon::contracts::HealthBucket::Green),
        "hallucinated.py must not be green; got {:?} at {}",
        score.bucket,
        score.composite,
    );
}

#[tokio::test]
async fn typescript_hallucinated_fixture_flags_imaginary_and_allows_node_fs_promises() {
    let dir = repo_root().join("test/fixtures/ai-slop/typescript");
    let state = scan(dir).await;
    let w = state.workspace.read().await;
    let diags = w.diagnostics.get("hallucinated.ts").expect("file indexed");
    assert!(
        diags
            .iter()
            .any(|d| d.message.contains("imaginary-package")),
        "expected a diagnostic about imaginary-package, got: {:?}",
        diags.iter().map(|d| &d.message).collect::<Vec<_>>()
    );
    assert!(
        !diags.iter().any(|d| d.message.contains("node:fs/promises")),
        "node:fs/promises must be recognised as a builtin"
    );
}

#[tokio::test]
async fn cold_scan_under_latency_budget() {
    // Spec §8: cold scan 10k LOC in <5s. Our fixtures are tiny so the bar
    // is far tighter — if a single-digit-kLOC workspace takes more than a
    // second, something regressed in the scan pipeline.
    let dir = repo_root().join("test/fixtures/ai-slop/python");
    let started = std::time::Instant::now();
    let _state = scan(dir).await;
    let elapsed = started.elapsed();
    assert!(
        elapsed < std::time::Duration::from_millis(1500),
        "scan too slow: {elapsed:?} (budget 1.5s for the python fixture)"
    );
}

#[tokio::test]
async fn crossfile_fixture_flags_arity_mismatch_and_ignores_defaults() {
    let dir = repo_root().join("test/fixtures/ai-slop/crossfile");
    let state = scan(dir).await;
    let w = state.workspace.read().await;
    let diags = w.diagnostics.get("main.py").expect("main.py indexed");
    let messages: Vec<&String> = diags.iter().map(|d| &d.message).collect();
    assert!(
        diags
            .iter()
            .any(|d| d.code == "ive-crossfile/arity-mismatch" && d.message.contains("compute()")),
        "expected arity mismatch on compute(), got: {:?}",
        messages
    );
    assert!(
        !diags
            .iter()
            .any(|d| d.code == "ive-crossfile/arity-mismatch" && d.message.contains("log_event()")),
        "log_event() has a default arg; single-arg call must not trigger"
    );
}
