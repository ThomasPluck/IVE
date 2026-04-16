//! `ive-daemon` entry point.
//!
//! The daemon is a single binary, launched by the VSCode extension as a
//! long-running subprocess. It speaks line-delimited JSON-RPC on stdio.
//!
//! CLI surface:
//! - `ive-daemon --workspace PATH` (default: $PWD)
//! - `ive-daemon scan --workspace PATH` one-shot CLI scan
//!
//! All analysis state lives in memory; Merkle cache under `.ive/cache/` is a
//! follow-up.

use anyhow::Context;
use clap::{Parser, Subcommand};
use ive_daemon::{config::Config, events, rpc, state::State, watcher};
use std::path::PathBuf;
use tracing::info;

#[derive(Parser, Debug)]
#[command(name = "ive-daemon", version, about = "IVE analysis daemon")]
struct Cli {
    /// Workspace root. Defaults to the current directory.
    #[arg(long, global = true)]
    workspace: Option<PathBuf>,

    /// Log level filter, overrides `RUST_LOG`.
    #[arg(long, global = true)]
    log_level: Option<String>,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// One-shot scan. Emits a JSON summary to stdout then exits.
    Scan,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let filter = cli
        .log_level
        .clone()
        .or_else(|| std::env::var("RUST_LOG").ok())
        .unwrap_or_else(|| "ive_daemon=info".into());
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .compact()
        .init();

    let root = cli
        .workspace
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let root = root
        .canonicalize()
        .with_context(|| format!("canonicalize workspace: {}", root.display()))?;

    let config = Config::load(&root).context("load .ive/config.toml")?;
    info!(root = %root.display(), "ive-daemon starting");
    let state = State::new(root, config);

    match cli.command {
        Some(Command::Scan) => {
            let (tx, mut rx) = events::channel();
            let state_clone = std::sync::Arc::clone(&state);
            let handle =
                tokio::spawn(async move { watcher::rescan_workspace(&state_clone, &tx).await });
            // Drain events silently for the CLI surface.
            while rx.recv().await.is_some() {}
            handle.await??;
            let w = state.workspace.read().await;
            let summary = serde_json::json!({
                "files": w.files.len(),
                "functions": w.function_scores.len(),
                "diagnostics": w.diagnostics.values().map(|v| v.len()).sum::<usize>(),
                "redFiles": w.file_scores.values().filter(|s| matches!(s.bucket, ive_daemon::contracts::HealthBucket::Red)).count(),
                "yellowFiles": w.file_scores.values().filter(|s| matches!(s.bucket, ive_daemon::contracts::HealthBucket::Yellow)).count(),
                "greenFiles": w.file_scores.values().filter(|s| matches!(s.bucket, ive_daemon::contracts::HealthBucket::Green)).count(),
            });
            println!("{}", serde_json::to_string_pretty(&summary)?);
            Ok(())
        }
        None => rpc::serve_stdio(state).await,
    }
}
