//! Golden-output end-to-end test (`spec §8`).
//!
//! For every repo under `test/golden/repos/<name>/`, run the daemon's
//! scan pipeline, normalise the result to a deterministic JSON shape,
//! and diff against `test/golden/snapshots/<name>.json`. A mismatch
//! fails the build; re-run with `IVE_GOLDEN_UPDATE=1` to accept the
//! new output.
//!
//! External subprocess-backed analyzers (Pyright, Semgrep) are
//! excluded via env vars so the snapshot doesn't flap based on what
//! happens to be installed on CI.

use ive_daemon::{
    config::Config,
    contracts::{DiagnosticSource, HealthBucket, HealthTarget},
    events,
    state::State,
    watcher,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn isolate(fixture: &Path) -> PathBuf {
    let stem = fixture.file_name().unwrap().to_string_lossy().into_owned();
    let dest = std::env::temp_dir().join(format!(
        "ive-golden-{}-{}-{}",
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

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Snapshot {
    files: Vec<FileEntry>,
    diagnostics: Vec<DiagEntry>,
    file_scores: Vec<ScoreEntry>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct FileEntry {
    path: String,
    loc: u32,
    functions: Vec<FunctionEntry>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct FunctionEntry {
    name: String,
    cc: u32,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct DiagEntry {
    file: String,
    line: u32,
    code: String,
    severity: String,
    message_prefix: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct ScoreEntry {
    path: String,
    bucket: String,
    composite_hundredths: u32,
}

async fn capture(workspace: PathBuf) -> Snapshot {
    let config = Config::load(&workspace).unwrap();
    let state = State::new(workspace.canonicalize().unwrap(), config);
    let (tx, mut rx) = events::channel();
    let s = Arc::clone(&state);
    let task = tokio::spawn(async move { watcher::rescan_workspace(&s, &tx).await });
    while rx.recv().await.is_some() {}
    task.await.unwrap().unwrap();

    let w = state.workspace.read().await;

    let mut files: Vec<FileEntry> = w
        .files
        .values()
        .map(|sf| FileEntry {
            path: sf.relative_path.clone(),
            loc: sf.loc,
            functions: {
                let mut fns: Vec<FunctionEntry> = sf
                    .functions
                    .iter()
                    .map(|f| FunctionEntry {
                        name: f.name.clone(),
                        cc: f.cognitive_complexity,
                    })
                    .collect();
                fns.sort_by(|a, b| a.name.cmp(&b.name));
                fns
            },
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let mut diagnostics: Vec<DiagEntry> = w
        .diagnostics
        .iter()
        .flat_map(|(_, ds)| ds.iter())
        .filter(|d| {
            // Exclude subprocess-dependent sources so CI snapshots don't
            // depend on what's installed on the runner.
            !matches!(
                d.source,
                DiagnosticSource::Pyright
                    | DiagnosticSource::Tsc
                    | DiagnosticSource::RustAnalyzer
                    | DiagnosticSource::Semgrep
                    | DiagnosticSource::Pytea
                    | DiagnosticSource::Glslang
            )
        })
        .map(|d| DiagEntry {
            file: d.location.file.clone(),
            line: d.location.range.start[0],
            code: d.code.clone(),
            severity: format!("{:?}", d.severity).to_ascii_lowercase(),
            message_prefix: d.message.chars().take(80).collect(),
        })
        .collect();
    diagnostics.sort_by(|a, b| {
        a.file
            .cmp(&b.file)
            .then(a.line.cmp(&b.line))
            .then(a.code.cmp(&b.code))
    });

    let mut file_scores: Vec<ScoreEntry> = w
        .file_scores
        .values()
        .map(|s| {
            let path = match &s.target {
                HealthTarget::File { file } => file.clone(),
                _ => "(unknown)".to_string(),
            };
            ScoreEntry {
                path,
                bucket: match s.bucket {
                    HealthBucket::Green => "green".into(),
                    HealthBucket::Yellow => "yellow".into(),
                    HealthBucket::Red => "red".into(),
                },
                composite_hundredths: (s.composite * 100.0).round() as u32,
            }
        })
        .collect();
    file_scores.sort_by(|a, b| a.path.cmp(&b.path));

    Snapshot {
        files,
        diagnostics,
        file_scores,
    }
}

fn snapshot_path(name: &str) -> PathBuf {
    repo_root()
        .join("test")
        .join("golden")
        .join("snapshots")
        .join(format!("{name}.json"))
}

fn pretty(snap: &Snapshot) -> String {
    serde_json::to_string_pretty(snap).unwrap() + "\n"
}

async fn run_golden(name: &str) {
    std::env::set_var("IVE_SKIP_PYRIGHT", "1");
    let src = repo_root().join("test/golden/repos").join(name);
    let isolated = isolate(&src);
    let actual = capture(isolated).await;

    let path = snapshot_path(name);
    if std::env::var("IVE_GOLDEN_UPDATE").is_ok() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, pretty(&actual)).unwrap();
        eprintln!("IVE_GOLDEN_UPDATE: wrote {}", path.display());
        return;
    }

    let expected_text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => {
            panic!(
                "golden snapshot {} missing. Re-run with IVE_GOLDEN_UPDATE=1 to create it.",
                path.display()
            );
        }
    };
    let expected: Snapshot = serde_json::from_str(&expected_text).expect("parse snapshot");

    if actual != expected {
        let actual_pretty = pretty(&actual);
        eprintln!(
            "golden mismatch for {}\n---expected---\n{}\n---actual---\n{}",
            name, expected_text, actual_pretty
        );
        panic!("golden snapshot drift. Re-run with IVE_GOLDEN_UPDATE=1 after reviewing the diff.");
    }
}

#[tokio::test]
async fn golden_ministore_is_stable() {
    run_golden("ministore").await;
}
