//! End-to-end fixture test — runs the daemon's `rescan_workspace` against
//! the sidecars in `test/fixtures/ai-slop/` and asserts the invariants each
//! YAML documents. Failures here should block a PR.

use ive_daemon::{config::Config, events, state::State, watcher};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

/// Copy a fixture into an isolated tempdir so the scan does not discover the
/// surrounding IVE git repo. Without this, `git churn` walks the full repo
/// and the latency test becomes flaky on CI machines.
fn isolate(fixture: &Path) -> PathBuf {
    let stem = fixture.file_name().unwrap().to_string_lossy().into_owned();
    let dest = std::env::temp_dir().join(format!(
        "ive-fixture-{}-{}-{}",
        stem,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    copy_dir(fixture, &dest).expect("copy fixture");
    dest
}

fn copy_dir(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if ty.is_dir() {
            copy_dir(&from, &to)?;
        } else if ty.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
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
    let dir = isolate(&repo_root().join("test/fixtures/ai-slop/python"));
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
    let dir = isolate(&repo_root().join("test/fixtures/ai-slop/typescript"));
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
async fn webgl_binding_fixture_flags_missing_uniform() {
    let dir = isolate(&repo_root().join("test/fixtures/ai-slop/webgl"));
    let state = scan(dir).await;
    let w = state.workspace.read().await;
    let diags = w
        .diagnostics
        .get("renderer.ts")
        .expect("renderer.ts indexed");
    assert!(
        diags
            .iter()
            .any(|d| d.code == "ive-binding/unknown-uniform" && d.message.contains("uTexture")),
        "expected unknown-uniform diag for uTexture; got: {:?}",
        diags.iter().map(|d| &d.message).collect::<Vec<_>>()
    );
    assert!(
        !diags
            .iter()
            .any(|d| d.code == "ive-binding/unknown-uniform" && d.message.contains("uProjection")),
        "uProjection is a real uniform and must not flag"
    );
}

#[tokio::test]
async fn cold_scan_under_latency_budget() {
    // Spec §8: cold scan 10k LOC in <5s. Our fixtures are tiny, but they run
    // inside an isolated tempdir — no outer git discovery, no semgrep — so
    // a fixture scan is a lower bound on scan-pipeline cost. Budget is
    // tuned for CI: anything under 1.5s is comfortably within spec.
    let dir = isolate(&repo_root().join("test/fixtures/ai-slop/python"));
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
    let dir = isolate(&repo_root().join("test/fixtures/ai-slop/crossfile"));
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
