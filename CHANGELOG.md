# CHANGELOG

## [Unreleased]

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
