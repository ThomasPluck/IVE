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
