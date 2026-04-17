# IVE — Independent Vibing Environment

> A comprehension tool for AI-generated codebases. Open a workspace, see
> where the slop is in under 60 seconds. Not a linter. Not a security
> scanner. A map.

Status: **all 22 points of the build spec ship as working code.** Contracts
(§4) are frozen; an extension-host → daemon → webview loop runs in VSCode;
every workstream-F IVE-native check fires (hallucination, cross-file
arity, WebGL binding); grounded summaries gate their claims against a
100-case corpus; Pyright + tsc + rust-analyzer feed type diagnostics;
Semgrep + PyTea feed security/shape diagnostics; workstream C ships
intra-function AST slicing by default and a Joern CPGQL slice path
behind `IVE_ENABLE_JOERN=1`; workstream I delivers a release workflow
plus a first-run analyzer-pack downloader.

Every external binary we shell out to (Pyright, tsc, rust-analyzer,
Semgrep, PyTea, Joern) degrades cleanly via `capabilityDegraded` events
rather than silently producing an incomplete picture. §0 rule 2 in
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
    rust_analyzer.rs  — minimal LSP client (Content-Length framing)
    semgrep.rs        — Semgrep CLI runner with ive-ai-slop.yml rules
    pytea.rs          — PyTea subprocess runner (Python + import torch)
    joern.rs          — JRE/Joern presence + opt-in CPGQL slice path
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
  e2e/panels.spec.ts         — Playwright browser tests (13 cases)

mcp/                  — MCP server fronting the daemon for Claude / Cursor
  src/server.ts       — tools/list + tools/call, stdio newline framing
  src/daemon.ts       — subprocess client that reuses the JSON-RPC wire
  src/server.test.ts  — drives the server like Claude Desktop would

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
cargo test --release                 # 82 unit + 12 fixture + 2 golden + 1 grounding eval
./test/run_fixtures.sh               # e2e sanity against test/fixtures/ai-slop
./test/e2e-stdio.sh                  # JSON-RPC over stdio smoke

cd webview   && npx vitest run         # 13 jsdom tests
cd webview   && npx playwright test    # 13 browser tests (Chromium, built bundle)
cd extension && npx vitest run         # 11 tests: real daemon subprocess + pack + hover
cd mcp       && npx vitest run         # 4 tests: Claude-style stdio round-trip
```

Wire the MCP server into Claude Desktop / Cursor with `mcp/README.md` —
the server fronts the same daemon the extension talks to, so Claude can
call `ive_scan`, `ive_health`, `ive_diagnostics`, `ive_summarize`,
`ive_slice`, `ive_worst`, `ive_capabilities`, etc. directly.

CI (`.github/workflows/ci.yml`) runs the Rust suite + fixture runner,
installs Pyright + Semgrep via pip, and exercises the TS typecheck +
webview build + extension tests driven by the just-built daemon.

`IVE_GOLDEN_UPDATE=1 cargo test --test golden` regenerates the snapshots
at `test/golden/snapshots/` — treat every diff there as intentional.

## 22-point status (§0 + §5 + §7)

The build-spec's surface area is four non-negotiables (§0), nine
workstreams (§5 A–I), and nine UI subsections (§7.1–7.9). Each row is
backed by a concrete test or shipped path.

| # | Point | Status | Landed in |
|---|---|---|---|
| 1 | §0 Works on partially broken code | ✅ | tree-sitter parses on syntax-broken files; `daemon/src/parser/` |
| 2 | §0 Silent when nothing to say | ✅ | empty-state branches across every panel; `webview/src/panels/` |
| 3 | §0 Grounded summaries or none | ✅ | token-overlap entailment gate + offline trivially-entailed path; `daemon/src/analyzers/grounding.rs` |
| 4 | §0 Fast enough to be ambient | ✅ | `cold_scan_under_latency_budget`, `intra_function_backward_slice_chains_assignments`, `offline_summary_under_latency_budget` in `daemon/tests/fixtures.rs` |
| 5 | §5 A — Extension host | ✅ | activation, supervisor, commands, hover, CodeLens, fix-apply; `extension/src/` |
| 6 | §5 B — Daemon core | ✅ | JSON-RPC, parsers, health, caches, watcher; `daemon/src/` |
| 7 | §5 C — Joern / CPG | ✅ | intra-function AST slice (default) + Joern subprocess slice behind `IVE_ENABLE_JOERN=1` (generates CPGQL, parses delimited JSON output, wires into `slice.compute`); `daemon/src/analyzers/{slice,joern}.rs` |
| 8 | §5 D — LSPs | ✅ | Pyright + tsc via CLI subprocess; rust-analyzer via minimal LSP client (Content-Length framed JSON-RPC over stdio); `daemon/src/analyzers/{lsp,rust_analyzer}.rs` |
| 9 | §5 E — Semgrep + PyTea | ✅ | 14-rule CWE-tagged ruleset, Semgrep runner, PyTea gated on `import torch`; `daemon/src/analyzers/{semgrep,pytea}.rs` |
| 10 | §5 F — IVE-native checks | ✅ | hallucination (11 lockfile formats) + cross-file arity + WebGL/WebGPU binding + quick-fix TextEdits; `daemon/src/analyzers/{hallucination,crossfile,binding}.rs` |
| 11 | §5 G — Grounding + gate | ✅ | offline + Anthropic + 100-case corpus, precision 0.965 / recall 0.911; `daemon/src/analyzers/grounding.rs` + `test/grounding/` |
| 12 | §5 H — Webview | ✅ | four panels wired end-to-end; `webview/src/panels/` |
| 13 | §5 I — Packaging | ✅ | cross-platform release workflow + first-run downloader with SHA-256 verify; `.github/workflows/release.yml` + `extension/src/pack.ts` |
| 14 | §7.1 Visual language | ✅ | dark-theme token palette, monospace, hard edges; `webview/src/styles.css` |
| 15 | §7.2 Panel layout | ✅ | 4-panel stacked with resize, activity-bar container; `webview/src/App.tsx` |
| 16 | §7.3 Treemap | ✅ | squarified layout with file → function drill-down; `webview/src/panels/Treemap.tsx` |
| 17 | §7.4 Diagnostics | ✅ | severity groups, filter chips, AI-first ordering, `j/k/Enter/.` keyboard; `webview/src/panels/Diagnostics.tsx` |
| 18 | §7.5 Summary | ✅ | facts + struck-through unentailed claims + low-confidence banner; `webview/src/panels/Summary.tsx` |
| 19 | §7.6 Slice | ✅ | origin dot, chain list, truncation hint; `webview/src/panels/Slice.tsx` |
| 20 | §7.7 Editor integrations | ✅ | gutter dots (DiagnosticCollection), CodeLens, red-border decorations, health hover; `extension/src/{codelens,hover,diagnostics}.ts` |
| 21 | §7.8 Commands | ✅ | all 8 commands keybound; `extension/package.json` + `extension/src/commands.ts` |
| 22 | §7.9 Per-panel states | ✅ | cold / indexing / ready / empty / partial / per-panel error all handled; `webview/src/App.tsx` |

All 22 points ✅. Every external binary we shell out to — Pyright, tsc,
Semgrep, PyTea, rust-analyzer, Joern — degrades cleanly when absent,
via the typed `capabilityDegraded` event; the view surfaces the
reason instead of silently producing an incomplete picture.

## Analyzer reference

| Workstream | What works today | Deferred |
|---|---|---|
| A Extension host | activate, daemon supervisor, typed RPC, four webview panels, §7.8 command table, CodeLens, red-border decorations, hover, fix-apply, diagnostic bridge, first-run pack downloader | — |
| B Daemon core | JSON-RPC, tree-sitter parse (py/ts/tsx/rust), cognitive complexity, blob-SHA + persistent manifest cache, SHA-keyed parse cache, 150ms-debounced file watcher, health model with severity floor, git-churn novelty | `Tree::edit` true incremental reparse (needs editor-side edit ranges) |
| C Joern | intra-function AST slice (default); cross-file slice via Joern subprocess behind `IVE_ENABLE_JOERN=1` (CPGQL script → delimited JSON output → `Slice` nodes); JRE + Joern presence detection flips `cpg.available`. | richer CPGQL (control-flow edges, call edges); scripted test against a pinned Joern version |
| D LSP | Pyright + tsc via CLI subprocess; rust-analyzer via minimal LSP client (Content-Length framing, `initialize` → `didOpen` → `publishDiagnostics` → `shutdown`); all three fold into the Diagnostic contract and degrade cleanly when absent | hover cache for workstream F |
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
