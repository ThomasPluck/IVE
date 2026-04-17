# IVE — Independent Vibing Environment

> A comprehension tool for AI-generated codebases. Open a workspace, see
> where the slop is in under 60 seconds. Not a linter. Not a security
> scanner. A map.

Status: **M0–M2 foundation landed** plus early pieces of M3–M6. Contracts
(§4) are frozen, a full extension-host → daemon → webview pipeline ships,
and three IVE-native checks run end-to-end: hallucinated imports,
cross-file arity mismatches, and per-function cognitive-complexity +
coupling. The grounded-summary path calls Claude when
`ANTHROPIC_API_KEY` is set and falls back to a deterministic fact-only
rendering otherwise, both gated by a token-overlap entailment check.

Workstreams C (Joern/CPG), D (LSP), and the Semgrep subprocess runner in
E remain **stubbed** — they surface as `capabilityDegraded` events
rather than silent no-ops.

This README is oriented toward **agents continuing the build**. Read the
relevant workstream section in this README and the referenced spec
sections before touching code.

---

## Layout

```
Cargo.toml            — Rust workspace root
daemon/               — Workstream B: analysis daemon (binary: ive-daemon)
  src/contracts.rs    — §4 wire contract (Rust side)
  src/parser/         — tree-sitter per-language extractors + complexity
  src/analyzers/
    crossfile.rs      — cross-file arity mismatch (workstream F)
    hallucination.rs  — lockfile-driven import check (workstream F)
    grounding.rs      — LLM + offline summaries (workstream G)
    semgrep.rs        — CLI wrapper stub (workstream E)
    joern.rs / lsp.rs — degraded-capability stubs (workstreams C, D)
  src/cache.rs        — blob-SHA + persistent manifest Merkle cache
  src/git.rs          — git churn → novelty
  src/health.rs       — §6 model
  src/rpc.rs          — line-delimited JSON-RPC over stdio
  src/watcher.rs      — 150ms-debounced file watcher + rescan pipeline
  tests/fixtures.rs   — CI-gated integration tests

extension/            — Workstream A: VSCode extension host
  src/extension.ts    — activation, subprocess supervisor, wiring
  src/contracts.ts    — §4 wire contract (TS mirror)
  src/daemon.ts       — typed RPC client with exponential backoff restart
  src/panel.ts        — webview lifecycle + message bridge
  src/codelens.ts     — per-function health CodeLens + red-border decos
  src/commands.ts     — §7.8 command table
  src/diagnostics.ts  — bridge to vscode.DiagnosticCollection

webview/              — Workstream H: React UI (squarified treemap)
  src/panels/Treemap.tsx     — workspace + function drill-down
  src/panels/Diagnostics.tsx — severity groups, filter chips
  src/panels/Summary.tsx     — grounded-summary renderer
  src/panels/Slice.tsx       — empty/degraded state

rules/                — Workstream E: curated AI-slop Semgrep rules
test/fixtures/        — YAML-sidecar regression fixtures (python, typescript, crossfile)
```

## Build

### Prerequisites
- Rust stable 1.90+
- Node 22+
- (later) Java 17+ for Joern, Semgrep CLI for Semgrep rules, an Anthropic API key for LLM summaries

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
cargo test --release                 # 51 unit + 3 integration = 54 Rust tests
./test/run_fixtures.sh               # e2e sanity against test/fixtures/ai-slop
./test/e2e-stdio.sh                  # JSON-RPC over stdio smoke

cd webview && npx vitest run         # 5 tests: treemap layout, Diagnostics render
cd extension && npx vitest run       # 4 tests: real daemon subprocess via JSON-RPC
```

CI (`.github/workflows/ci.yml`) runs the Rust suite + fixture runner,
then the TS typecheck + webview build + extension tests driven by the
just-built daemon.

## What's real vs. stubbed

| Workstream | What works today | What's stubbed |
|---|---|---|
| A Extension host | activate, spawn daemon, lifecycle, RPC, webview, commands, CodeLens, red-border decos, diagnostics bridge | — |
| B Daemon core | JSON-RPC, tree-sitter parse, cognitive complexity, blob-SHA cache (mem + persistent manifest), health model, workspace.scan, **150ms-debounced file watcher**, git-churn novelty | incremental reparse via `Tree::edit` |
| C Joern | — | CPG-backed paths emit `capabilityDegraded{capability:"cpg"}`; see `daemon/src/analyzers/joern.rs` |
| D LSP | — | Pyright/tsc/rust-analyzer spawning; see `daemon/src/analyzers/lsp.rs` |
| E Semgrep | ruleset seed `rules/ive-ai-slop.yml` | subprocess runner in `daemon/src/analyzers/semgrep.rs` |
| F IVE-native | hallucination (requirements.txt, pyproject.toml, poetry.lock, uv.lock, Pipfile.lock, package.json, package-lock.json, pnpm-lock.yaml, yarn.lock + stdlib/builtin allowlists + workspace-local module whitelist); **cross-file arity mismatch** | WebGL/WebGPU bindings (v1.1) |
| G Grounding | offline fact-only summary; LLM summary via Anthropic Messages API when `ANTHROPIC_API_KEY` is set; token-overlap entailment gate | CPG-indexed entailment (needs C); proper NLI |
| H Webview | Treemap with breadcrumb drill-down, Diagnostics (grouped, filter chips, keyboard-navigable), Summary (struck-through unentailed claims), Slice empty/degraded state | function-level treemap hover hints, FULL slice visual |
| I Packaging | — | first-run analyzer-pack downloader |

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
