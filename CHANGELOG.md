# CHANGELOG

## [Unreleased]

### M1+M2 — extension depth

- **Debounced watcher (spec §2)** — 150ms notify-based debouncer spawned
  from `serve_stdio`; touched files re-emit `diagnosticsUpdated`.
- **CodeLens + red-border decorations (spec §7.7)** — per-function
  health line above each function, plus a 2px red left-border on
  `composite > 0.6` ranges. Re-fires on every `healthUpdated` event.
- **Treemap drill-down (spec §7.3)** — click a file leaf to see a
  function-level treemap; breadcrumb navigates back to workspace.
- **Cross-file arity mismatch (workstream F)** — unambiguous workspace
  definitions paired to bare-name call sites; severity=error, source
  `ive-crossfile`. Handles Python defaults/variadic and TypeScript
  optional/rest/default parameters.
- **Git churn → novelty** — `git log --numstat --since=14.days`
  parsed into a per-file churn map, fed into function-level novelty.
  Degrades gracefully when git is absent.
- **Persistent Merkle cache** — `.ive/cache/manifest.json` survives
  restart so the first scan after reopening the workspace counts hits;
  analyzer-version bump invalidates everything; prune drops artifacts
  whose blob isn't live.
- **Local-module whitelist** — `hallucination::LocalModules` resolves
  top-level `.py` files and package dirs as workspace-local, so
  `from lib import …` no longer flags when `lib.py` exists in-tree.
- **File-level severity floor** — error/critical diagnostics push a file
  to at least the yellow boundary (0.3) even when function-level scores
  are low.

### M3–M6 — grounded summaries, packaging hooks

- **LLM summaries via Claude (workstream G)** — `summarize()` picks the
  Anthropic path when `ANTHROPIC_API_KEY` is set, else falls back to the
  deterministic fact-only summary. `IVE_LLM_MODEL` overrides the model
  (default `claude-haiku-4-5`).
- **Token-overlap entailment gate** — every sentence in the response is
  checked against the fact set; unentailed sentences carry a
  `reason: "no supporting fact found"` so the UI can strike them through.
- **.vscode launch/tasks** — `build:all` pre-launch task, default and
  fixture-workspace debug configs with `IVE_DAEMON_PATH` wired.

### M0 — foundation

- **Contracts (§4)** — Rust (`daemon/src/contracts.rs`) and TypeScript
  (`extension/src/contracts.ts`) mirrors, both camelCase on the wire.
- **Daemon (workstream B)** — `ive-daemon` binary, JSON-RPC 2.0 over
  stdio (line-delimited), file scanner with `ignore`-crate traversal,
  blob-SHA cache (in-memory v1).
- **Parsers (workstream B)** — tree-sitter Python and TypeScript/TSX,
  per-function extraction with qualified names and local call-site
  identifiers.
- **Cognitive complexity (spec §6)** — Campbell 2017 visitor: flow +1 +
  nesting, else/elif flat +1, short-circuit chain +1-per-operator-flip.
- **Hallucinated imports (workstream F)** — lockfile readers for
  requirements.txt, pyproject.toml (PEP 621 + Poetry table), poetry.lock,
  uv.lock, Pipfile.lock, package.json, package-lock.json, pnpm-lock.yaml,
  yarn.lock. Stdlib + Node-builtin allowlists including `node:` subpaths.
- **Health model (spec §6)** — per-function composite from novelty,
  cognitive complexity, coupling, AI signal; file-level blend with a
  severity floor so one hallucinated import forces at least yellow.
- **Extension host (workstream A)** — subprocess supervisor with
  exponential-backoff restart, typed RPC client, diagnostic bridge to
  VSCode problems panel, §7.8 command table registered and keybound.
- **Webview (workstream H)** — React + Vite, four-panel layout with
  squarified treemap (pure deterministic layout), grouped diagnostics
  with AI-first ordering, Summary + Slice empty-state skeletons, spec §7.1
  dark-theme tokens.
- **Fixtures (§8)** — `test/fixtures/ai-slop/python/` and
  `test/fixtures/ai-slop/typescript/` with YAML sidecars. Enforced by
  `daemon/tests/fixtures.rs` and `test/run_fixtures.sh` in CI.
- **Semgrep ruleset seed (workstream E)** —
  `rules/ive-ai-slop.yml` with five starter rules. Runner pending.
- **Graceful degradation** — Joern, Semgrep, LSP, LLM each advertise
  `capabilityDegraded` on first use when not available, never silently
  drop results.

### Known stubs (tracked in README)

- Joern/CPG integration (workstream C) — slice.compute returns
  `capability unavailable`.
- LSP integrations (workstream D).
- Semgrep subprocess runner (workstream E).
- LLM + entailment gate (workstream G) — offline fact-only summary ships.
- Packaging / analyzer-pack downloader (workstream I).
