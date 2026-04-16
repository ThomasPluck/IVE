# IVE — Independent Vibing Environment

> A comprehension tool for AI-generated codebases. Open a workspace, see
> where the slop is in under 60 seconds. Not a linter. Not a security
> scanner. A map.

Status: **M0 foundation landed.** Scaffold for all workstreams is in place,
contracts (§4) are frozen, and a working end-to-end slice ships:
tree-sitter parsing for Python + TypeScript, cognitive-complexity scoring,
hallucinated-import detection, health model, and the four-panel webview
skeleton. Downstream analyzers (Joern / Pyright / Semgrep / LLM) are
wired as workstream stubs that advertise `capabilityDegraded` until their
owning agents land them.

This README is oriented toward **agents continuing the build**. Read the
[build spec](#spec) and the relevant workstream section in the spec before
touching code.

---

## Layout

```
Cargo.toml          — Rust workspace root
daemon/             — Workstream B: analysis daemon (binary: ive-daemon)
  src/contracts.rs  — §4 wire contract (Rust side)
  src/parser/       — tree-sitter per-language extractors
  src/analyzers/    — hallucination (landed), joern/lsp/semgrep/grounding (stub)
  src/health.rs     — §6 model
  src/rpc.rs        — JSON-RPC over stdio
  tests/fixtures.rs — CI-gated integration tests
extension/          — Workstream A: VSCode extension host
  src/contracts.ts  — §4 wire contract (TS mirror)
  src/daemon.ts     — spawns ive-daemon, types the RPC wire
  src/panel.ts      — webview lifecycle + message bridge
  src/commands.ts   — §7.8 commands
webview/            — Workstream H: React UI
  src/panels/       — Treemap, Diagnostics, Summary, Slice
  src/panels/treemap.ts — squarified layout (pure, testable)
rules/              — Workstream E: curated AI-slop Semgrep rules
test/fixtures/      — YAML-sidecar-driven regression fixtures
```

## Build

### Prerequisites
- Rust stable 1.90+
- Node 22+
- (later) Java 17+ for Joern, Semgrep CLI for Semgrep rules, API key for LLM summaries

### Build everything

```bash
# daemon
cargo build --release

# webview  → emits into extension/dist/webview
cd webview && npm install && npm run build && cd ..

# extension bundle  → emits into extension/dist/extension.js
cd extension && npm install && node esbuild.mjs && cd ..
```

### Run in VSCode

Open this repo in VSCode, press **F5**. An Extension-Development Host opens
with IVE activated; switch to the IVE view in the activity bar. The
extension looks for `ive-daemon` in (in order) `ive.daemon.path`,
`extension/bin/`, then `target/release/` and `target/debug/`.

### Run the daemon directly

```bash
# one-shot scan, prints JSON summary
./target/release/ive-daemon scan --workspace path/to/repo

# long-running JSON-RPC mode (what the extension uses)
./target/release/ive-daemon --workspace path/to/repo
# then send a frame on stdin, e.g.:
#   {"jsonrpc":"2.0","id":1,"method":"ping","params":null}\n
```

## Test

```bash
cargo test --release                 # 37 tests: contracts, parser, health, hallucination, fixtures
./test/run_fixtures.sh               # end-to-end sanity against test/fixtures/ai-slop

cd webview && npm test               # 5 tests: treemap layout, Diagnostics render
cd extension && npx vitest run       # 4 tests: real daemon subprocess via JSON-RPC
```

## What's real vs. stubbed

| Workstream | What works today | What's stubbed |
|---|---|---|
| A Extension host | activate, spawn daemon, lifecycle, RPC, webview, commands, diagnostics bridge | — |
| B Daemon core | JSON-RPC, tree-sitter parse, cognitive complexity, blob SHA cache (in-mem), health model, workspace.scan | persistent `.ive/cache/`, incremental reparse via `Tree::edit` |
| C Joern | — | every CPG-backed path emits `capabilityDegraded{capability:"cpg"}`. See `daemon/src/analyzers/joern.rs` |
| D LSP | — | Pyright/tsc/rust-analyzer spawning. See `daemon/src/analyzers/lsp.rs` |
| E Semgrep | ruleset seed `rules/ive-ai-slop.yml` | subprocess runner in `daemon/src/analyzers/semgrep.rs` |
| F IVE-native | hallucination check: requirements.txt, pyproject.toml, poetry.lock, uv.lock, Pipfile.lock, package.json, package-lock.json, pnpm-lock.yaml, yarn.lock + stdlib/builtin allowlists | cross-file API mismatch, WebGL/WebGPU bindings |
| G Grounding | offline fact-only summaries (`summary.generate` works without an LLM) | real LLM call + entailment gate |
| H Webview | Treemap (squarified, d3-free), Diagnostics (grouped, filter chips), Summary skeleton, Slice skeleton | unentailed-claim strike-through, slice rendering |
| I Packaging | — | first-run analyzer-pack downloader |

## Contracts (§4)

All cross-process types live in `daemon/src/contracts.rs` and
`extension/src/contracts.ts`. They are 1:1 and serialised as camelCase on
the JSON-RPC wire. Any change is a review-blocking PR.

## Design philosophy

From `spec §0`:
1. Works on partially broken code.
2. Silent when there's nothing to say.
3. Grounded summaries or no summaries.
4. Fast enough to be ambient.

If a change violates these it's a revert.

## Spec

The full build spec is the source of truth for agent delegation. It lives
with the project owner, not in-repo. For the scope each agent needs, see
the corresponding workstream block in this README and the referenced spec
sections.

## License

MIT — see LICENSE.
