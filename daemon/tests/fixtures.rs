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
    // Spec §8: cold scan 10k LOC in <5s. This test isolates scan-pipeline
    // cost — no outer git discovery, no semgrep, no Pyright (Pyright has
    // its own cold-start cost that isn't ours to blame). Budget is tuned
    // for CI: anything under 1.5s is comfortably within spec.
    std::env::set_var("IVE_SKIP_PYRIGHT", "1");
    std::env::set_var("IVE_SKIP_SEMGREP", "1");
    std::env::set_var("IVE_SKIP_TSC", "1");
    let dir = isolate(&repo_root().join("test/fixtures/ai-slop/python"));
    let started = std::time::Instant::now();
    let _state = scan(dir).await;
    let elapsed = started.elapsed();
    std::env::remove_var("IVE_SKIP_PYRIGHT");
    std::env::remove_var("IVE_SKIP_SEMGREP");
    std::env::remove_var("IVE_SKIP_TSC");
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

#[tokio::test]
async fn rust_fixture_flags_hallucinated_crate_and_recognises_std_and_declared_deps() {
    let dir = isolate(&repo_root().join("test/fixtures/ai-slop/rust"));
    let state = scan(dir).await;
    let w = state.workspace.read().await;
    let diags = w
        .diagnostics
        .get("src/main.rs")
        .expect("src/main.rs indexed");
    let messages: Vec<&String> = diags.iter().map(|d| &d.message).collect();
    assert!(
        diags
            .iter()
            .any(|d| d.code == "ive-hallucination/unknown-import"
                && d.message.contains("imaginary_crate")),
        "expected hallucinated-crate diagnostic for imaginary_crate; got: {:?}",
        messages
    );
    assert!(
        !diags
            .iter()
            .any(|d| d.code == "ive-hallucination/unknown-import" && d.message.contains("std")),
        "std is a stdlib root and must not flag"
    );
    assert!(
        !diags
            .iter()
            .any(|d| d.code == "ive-hallucination/unknown-import" && d.message.contains("serde")),
        "serde is declared in Cargo.toml and must not flag"
    );
    let functions: Vec<&String> = w.function_scores.keys().collect();
    assert!(
        functions.iter().any(|s| s.ends_with("compute#.")),
        "compute() must appear as a Rust FunctionUnit; got keys: {:?}",
        functions
    );
}

/// Pyright-backed type diagnostics. Skipped (not failed) when Pyright isn't
/// on PATH — CI installs it via `pip install pyright` for this job.
#[tokio::test]
async fn pyright_fixture_flags_type_error_when_pyright_is_installed() {
    if !ive_daemon::analyzers::lsp::pyright_present() {
        eprintln!("skipping: pyright not on PATH");
        return;
    }
    let dir = isolate(&repo_root().join("test/fixtures/ai-slop/pyright"));
    let state = scan(dir).await;
    let w = state.workspace.read().await;
    let diags = w.diagnostics.get("broken.py").expect("broken.py indexed");
    assert!(
        diags
            .iter()
            .any(|d| matches!(d.source, ive_daemon::contracts::DiagnosticSource::Pyright)),
        "expected at least one pyright diagnostic; got sources: {:?}",
        diags
            .iter()
            .map(|d| format!("{:?}", d.source))
            .collect::<Vec<_>>()
    );
}

/// Intra-function backward slice (workstream C partial). No external
/// binaries — pure tree-sitter; always runs.
///
/// The fixture we ship here is a simple `def` with a sequence of
/// straight-line assignments; that's the case the thin slicer handles
/// unambiguously. Slicing into nested control flow is a known limit
/// (see `slice.rs` doc comment).
#[tokio::test]
async fn intra_function_backward_slice_chains_assignments() {
    use ive_daemon::analyzers::slice;
    use ive_daemon::contracts::{Location, Range, SliceDirection, SliceKind, SliceRequest};
    use ive_daemon::parser::Language;

    let tmp = std::env::temp_dir().join(format!(
        "ive-slice-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    let src = "def f(a):\n    x = a * 2\n    y = a + 1\n    result = x + y\n    return result\n";
    let path = tmp.join("a.py");
    std::fs::write(&path, src).unwrap();

    // Cursor inside `return result` (line index 4, col 11 hits `result`).
    let req = SliceRequest {
        origin: Location {
            file: "a.py".into(),
            range: Range {
                start: [4, 11],
                end: [4, 11],
            },
        },
        direction: SliceDirection::Backward,
        kind: SliceKind::Thin,
        max_hops: Some(10),
        cross_file: false,
    };
    let bytes = std::fs::read(&path).unwrap();
    let started = std::time::Instant::now();
    let outcome = slice::compute(&req, &bytes, Language::Python);
    let elapsed = started.elapsed();
    // §8 latency budget: slice backward 10 hops < 2s. Pure tree-sitter on
    // a five-statement fixture should finish in microseconds.
    assert!(
        elapsed < std::time::Duration::from_secs(2),
        "slice too slow: {elapsed:?} (budget 2s per spec §8)"
    );
    match outcome {
        slice::Outcome::Ok(s) => {
            let labels: Vec<String> = s.nodes.iter().map(|n| n.label.clone()).collect();
            assert!(
                labels.iter().any(|l| l.contains("return result")),
                "origin `return result` must be in slice; got: {labels:?}"
            );
            assert!(
                labels.iter().any(|l| l.contains("result = x + y")),
                "`result = x + y` must be in slice; got: {labels:?}"
            );
            assert!(
                labels.iter().any(|l| l.contains("x = a * 2")),
                "`x = a * 2` must be in slice; got: {labels:?}"
            );
            assert!(
                labels.iter().any(|l| l.contains("y = a + 1")),
                "`y = a + 1` must be in slice; got: {labels:?}"
            );
        }
        other => panic!(
            "expected Ok, got {}",
            match other {
                slice::Outcome::NeedsCpg(m) => format!("NeedsCpg({m})"),
                slice::Outcome::NoEnclosingFunction => "NoEnclosingFunction".into(),
                _ => "Ok".into(),
            }
        ),
    }
    std::fs::remove_dir_all(&tmp).ok();
}

/// Offline grounded summary for a 200-LOC function must finish well under
/// the §8 5s budget. No LLM is involved — this guards the deterministic
/// path that ships without `ANTHROPIC_API_KEY`.
#[tokio::test]
async fn offline_summary_under_latency_budget() {
    use ive_daemon::analyzers::grounding;
    use ive_daemon::contracts::{Location, Range};
    use ive_daemon::parser::FunctionUnit;
    use ive_daemon::scanner::ScannedFile;

    let file = ScannedFile {
        relative_path: "big.py".into(),
        language: ive_daemon::parser::Language::Python,
        loc: 200,
        functions: vec![],
        imports: (0..50)
            .map(|i| ive_daemon::scanner::ImportEntry {
                module: format!("mod_{i}"),
                range_start: [i as u32, 0],
                range_end: [i as u32, 10],
            })
            .collect(),
        blob_sha: "x".into(),
        bytes_read: 0,
        location: Location {
            file: "big.py".into(),
            range: Range {
                start: [0, 0],
                end: [199, 0],
            },
        },
    };
    let unit = FunctionUnit {
        symbol_id: "sym".into(),
        name: "fn".into(),
        location: Location {
            file: "big.py".into(),
            range: Range {
                start: [0, 0],
                end: [199, 0],
            },
        },
        cognitive_complexity: 12,
        loc: 200,
        local_callees: (0..20).map(|i| format!("callee_{i}")).collect(),
    };
    let facts = grounding::extract_facts(&file, &unit);
    let started = std::time::Instant::now();
    let summary = grounding::offline_summary(&unit, facts);
    let elapsed = started.elapsed();
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "offline summary too slow: {elapsed:?} (budget 5s per spec §8)"
    );
    assert!(!summary.facts_given.is_empty());
    assert!(summary.claims.iter().all(|c| c.entailed));
}

/// Semgrep-backed diagnostics. Skipped when the binary is missing; CI
/// installs it via `pip install semgrep`.
#[tokio::test]
async fn semgrep_fixture_flags_multiple_rules_when_installed() {
    if !ive_daemon::analyzers::semgrep::binary_present() {
        eprintln!("skipping: semgrep not on PATH");
        return;
    }
    std::env::set_var("IVE_SKIP_PYRIGHT", "1");
    let dir = isolate(&repo_root().join("test/fixtures/ai-slop/semgrep"));
    let state = scan(dir).await;
    std::env::remove_var("IVE_SKIP_PYRIGHT");
    let w = state.workspace.read().await;
    let diags = w.diagnostics.get("app.py").expect("app.py indexed");
    let semgrep_rules: std::collections::HashSet<String> = diags
        .iter()
        .filter(|d| matches!(d.source, ive_daemon::contracts::DiagnosticSource::Semgrep))
        .map(|d| d.code.clone())
        .collect();
    assert!(
        semgrep_rules.len() >= 3,
        "expected ≥3 distinct semgrep rule hits; got {:?}",
        semgrep_rules
    );
    let required = [
        "ive-ai-slop.eval-on-untyped-input",
        "ive-ai-slop.requests-no-verify",
        "ive-ai-slop.weak-hash-for-credentials",
    ];
    for r in required {
        assert!(
            semgrep_rules.iter().any(|c| c == r),
            "expected rule {r}; got {:?}",
            semgrep_rules
        );
    }
}

/// tsc-backed type diagnostics. Skipped when tsc isn't on PATH; ubuntu-
/// latest ships it via setup-node, and our CI job has the Node toolchain.
#[tokio::test]
async fn tsc_fixture_flags_type_errors_when_tsc_is_installed() {
    if !ive_daemon::analyzers::lsp::tsc_present() {
        eprintln!("skipping: tsc not on PATH");
        return;
    }
    let dir = isolate(&repo_root().join("test/fixtures/ai-slop/tsc"));
    let state = scan(dir).await;
    let w = state.workspace.read().await;
    let diags = w
        .diagnostics
        .get("src/broken.ts")
        .expect("broken.ts indexed");
    let tsc_count = diags
        .iter()
        .filter(|d| matches!(d.source, ive_daemon::contracts::DiagnosticSource::Tsc))
        .count();
    assert!(
        tsc_count >= 3,
        "expected ≥3 tsc diagnostics; got {} ({:?})",
        tsc_count,
        diags
            .iter()
            .map(|d| (format!("{:?}", d.source), d.code.clone()))
            .collect::<Vec<_>>()
    );
    assert!(
        diags.iter().any(
            |d| matches!(d.source, ive_daemon::contracts::DiagnosticSource::Tsc)
                && d.code == "TS2345"
        ),
        "expected TS2345 (argument-type mismatch)",
    );
}
