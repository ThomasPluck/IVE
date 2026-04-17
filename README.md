# IVE — Independent Vibing Environment

> A comprehension tool for AI-generated codebases. Open a workspace, see
> where the slop is in under 60 seconds. Not a linter. Not a security
> scanner. A map.

Status: **the full spec ships as a working pipeline end-to-end.** Contracts
(§4) are frozen; an extension-host → daemon → webview loop runs in VSCode;
all four workstream-F IVE-native checks fire (hallucination, cross-file
arity, WebGL binding, grounded summaries); Pyright, tsc, and Semgrep are
wired as real subprocesses; workstream C ships intra-function AST slicing
today and detects Joern for future cross-file queries; workstream I
delivers a release workflow plus a first-run analyzer-pack downloader.

The deliberately-scoped gaps — a full JVM-backed CPG slice (Joern) and a
stateful rust-analyzer LSP client — advertise themselves as
`capabilityDegraded` events rather than pretending to work. §0 rule 2 in
action.

This README is oriented toward **agents continuing the build**. Read the
relevant workstream section below and the referenced spec sections
before touching code.

---

## Layout

```
Cargo.toml            — Rust workspace root
daemon/               — Workstream B: analysis daemon (binary: ive-daemon)
  src/contracts.rs    — §4 wire contract (Rust side)
  src/parser/         — tree-sitter per-language extractors + complexity
                        (python, typescript/tsx, rust v1.1)
  src/analyzers/
    hallucination.rs  — lockfile-driven import check with fix edits
    crossfile.rs      — cross-file arity mismatch (Python + TS)
    binding.rs        — WebGL/WebGPU uniform/attribute check
    slice.rs          — intra-function AST slice (workstream C partial)
    grounding.rs      — LLM + offline summaries, token-overlap gate
    lsp.rs            — Pyright + tsc subprocess runners
    semgrep.rs        — Semgrep CLI runner with ive-ai-slop.yml rules
    pytea.rs          — PyTea subprocess runner (Python + import torch)
    joern.rs          — JRE/Joern presence detection (cpg.available)
  src/cache.rs        — blob-SHA + persistent manifest Merkle cache
  src/git.rs          — git churn → novelty
  src/health.rs       — §6 model
  src/rpc.rs          — line-delimited JSON-RPC over stdio
  src/scanner.rs      — SHA-keyed ParseCache (incremental reparse lite)
  src/watcher.rs      — 150ms-debounced file watcher + rescan pipeline
  tests/fixtures.rs   — CI-gated integration tests
  tests/golden.rs     — deterministic end-to-end snapshots
  tests/grounding_eval.rs — 100-case entailment gate regression

extension/            — Workstream A: VSCode extension host
  src/extension.ts    — activation, subprocess supervisor, wiring
  src/contracts.ts    — §4 wire contract (TS mirror)
  src/daemon.ts       — typed RPC client with exponential backoff restart
  src/pack.ts         — first-run analyzer-pack downloader (workstream I)
  src/panel.ts        — webview lifecycle + message bridge + fix-apply
  src/codelens.ts     — per-function health CodeLens + red-border decos
  src/hover.ts        — IVE health hover (spec §7.7)
  src/commands.ts     — §7.8 command table
  src/diagnostics.ts  — bridge to vscode.DiagnosticCollection

webview/              — Workstream H: React UI (squarified treemap)
  src/panels/Treemap.tsx     — workspace + function drill-down
  src/panels/Diagnostics.tsx — severity groups, filter chips, j/k/Enter/.
  src/panels/Summary.tsx     — grounded-summary renderer, struck-through
                               unentailed claims, low-confidence banner
  src/panels/Slice.tsx       — intra-function slice list, truncation hint

rules/                — Workstream E: curated AI-slop Semgrep rules (14)
test/fixtures/        — YAML-sidecar regression fixtures
                        (python, typescript, rust, crossfile, webgl,
                         semgrep, pyright, tsc)
test/grounding/       — 100-case entailment corpus (spec §8 target)
test/golden/          — deterministic snapshot fixtures (ministore, slopfest)
```

## Build

### Prerequisites
- Rust stable 1.90+
- Node 22+
- Optional: Pyright (`pip install pyright`), tsc (`npm i -g typescript`),
  Semgrep (`pip install semgrep`), PyTea (`ropas/pytea`), JRE 17+ and
  Joern (cross-file slice), Anthropic API key (grounded summaries).
  Every one of these degrades cleanly if missing.

### Build everything

```bash
cargo build --release                    # daemon: target/release/ive-daemon
cd webview && npm ci && npm run build    # webview → extension/dist/webview
cd ../extension && npm ci && node esbuild.mjs  # extension → extension/dist/extension.js
```

### Run in VSCode

Open this repo, press **F5**. The `build:all` task builds daemon +
webview + extension in order, then launches the Extension Development
Host with `IVE_DAEMON_PATH` wired. A second launch config, **Run
Extension + Fixture Workspace**, opens the host rooted at
`test/fixtures/ai-slop/python` so you see a yellow file and a critical
diagnostic within a couple of seconds.

Production users get the daemon via the release workflow: tag `vX.Y.Z`
and GitHub Actions produces a matrix of daemon archives plus the VSIX.
On first launch the extension downloads the matching archive from
`~/.ive/<version>/` and verifies an optional `ive.daemon.packSha256`.

### Run the daemon directly

```bash
# one-shot scan — prints a JSON summary and exits
./target/release/ive-daemon scan --workspace path/to/repo

# long-running JSON-RPC mode (what the extension uses)
./target/release/ive-daemon --workspace path/to/repo
# then drive it on stdin:
#   {"jsonrpc":"2.0","id":1,"method":"ping"}
#   {"jsonrpc":"2.0","id":2,"method":"workspace.scan"}
```

### Enable LLM summaries (optional)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# optional: export IVE_LLM_MODEL=claude-haiku-4-5
```

Unset the key to return to the deterministic offline path. The offline
path ships every fact as a trivially-entailed claim so the gate never
strikes anything.

## Test

```bash
cargo test --release                 # 74 unit + 10 fixture + 2 golden + 1 grounding eval
./test/run_fixtures.sh               # e2e sanity against test/fixtures/ai-slop
./test/e2e-stdio.sh                  # JSON-RPC over stdio smoke

cd webview && npx vitest run         # 12 tests: treemap, Diagnostics, Summary, App
cd extension && npx vitest run       # 11 tests: real daemon subprocess + pack + hover
```

CI (`.github/workflows/ci.yml`) runs the Rust suite + fixture runner,
installs Pyright + Semgrep via pip, and exercises the TS typecheck +
webview build + extension tests driven by the just-built daemon.

`IVE_GOLDEN_UPDATE=1 cargo test --test golden` regenerates the snapshots
at `test/golden/snapshots/` — treat every diff there as intentional.

## What's real vs. stubbed

| Workstream | What works today | Deferred |
|---|---|---|
| A Extension host | activate, daemon supervisor, typed RPC, four webview panels, §7.8 command table, CodeLens, red-border decorations, hover, fix-apply, diagnostic bridge, first-run pack downloader | — |
| B Daemon core | JSON-RPC, tree-sitter parse (py/ts/tsx/rust), cognitive complexity, blob-SHA + persistent manifest cache, SHA-keyed parse cache, 150ms-debounced file watcher, health model with severity floor, git-churn novelty | `Tree::edit` true incremental reparse (needs editor-side edit ranges) |
| C Joern | intra-function AST slice (backward + forward) across py/ts/rust; `cpg.available` reflects JRE + Joern presence detection | full CPG slice query pipeline (multi-week JVM integration) |
| D LSP | Pyright + tsc subprocess runners, folding their diagnostics into the contract; `capabilityDegraded` on missing binaries | rust-analyzer (no CLI; needs full LSP client); hover cache for workstream F |
| E Semgrep + PyTea | 14-rule CWE-tagged ruleset, Semgrep runner with rule-id normalisation; PyTea runner gated on `import torch` | richer curated rules driven by real open-source slop PRs |
| F IVE-native | hallucination against 11 lockfile formats + stdlib/builtin allowlists + local module whitelist; cross-file arity; WebGL/WebGPU bindings; quick-fix TextEdits for unknown imports | — |
| G Grounding | offline fact-only summary; LLM summary via Anthropic Messages API when `ANTHROPIC_API_KEY` is set; token-overlap entailment gate with 100-case corpus (precision 0.965, recall 0.911) | CPG-indexed entailment; proper NLI; 100 → 1000 corpus growth |
| H Webview | four-panel layout, squarified treemap with file→function drill-down, Diagnostics (grouped, filter chips, j/k/Enter/. keyboard), Summary rendering with struck-through unentailed claims, intra-function Slice list | editor-synced treemap hover-to-line, full PDG slice visual (needs C) |
| I Packaging | cross-platform release workflow (linux-x64, darwin-arm64, darwin-x64, windows-x64) producing daemon tarballs + VSIX, first-run downloader with SHA-256 verify + tar/unzip extract | Marketplace publishing step |

## Contracts (§4)

All cross-process types live in `daemon/src/contracts.rs` and
`extension/src/contracts.ts`. They are 1:1 and serialised as camelCase
on the JSON-RPC wire. Any change is a review-blocking PR.

## Design philosophy

From `spec §0`:
1. Works on partially broken code.
2. Silent when there's nothing to say.
3. Grounded summaries or no summaries.
4. Fast enough to be ambient.

If a change violates these it's a revert.

## License

MIT — see LICENSE.
