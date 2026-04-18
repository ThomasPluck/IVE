# Workstream handoffs

Per `spec §10`, each agent reads the **contracts (§4)**, the **architecture
(§1)**, and their own workstream section. This document lists the entry
points, file owners, and concrete next steps so the next agent on each
workstream can start without reading the whole tree.

## A — Extension host
**Files**: `extension/src/`
**Status**: complete for M0–M2. Ready for polish as downstream workstreams land.

Next steps:
- [ ] Apply `Fix.edits` when the user invokes a diagnostic's quick-fix
  (currently we only open the file). Introduce a `ive.applyFix` command
  bound to the CodeLens tooltip and the diagnostic row's `.` key.
- [ ] Status-bar entry showing `● {worst-file-path} · composite {X}`.
- [ ] `ive.explainComplexity` — fetch the function's complexity components
  and render a "why is this red" doc.

## B — Daemon core
**Files**: `daemon/src/`
**Status**: complete for M0 plus the watcher, cache, git churn, and health
pieces that were marked M4.

Next steps:
- [ ] Incremental reparse via `Tree::edit` in `parser/mod.rs` so steady-state
  saves don't re-build a tree from scratch.
- [ ] `cache.rs`: store artifacts (function metrics, import sets) keyed by
  `(blob_sha, query_hash)` on disk in `.ive/cache/artifacts/`, gated by a
  total-size LRU. The skeleton is in place (`ArtifactMeta`, `artifact_key`).
- [ ] Proper SCIP emission at `.ive/cache/index.scip` so external tools can
  query the symbol graph. Start from the `scip` crate or write Protobuf
  manually against the upstream schema.

## C — Joern / CPG
**Files**: `daemon/src/analyzers/joern.rs`
**Status**: stub — always reports `capabilityDegraded{capability:"cpg"}`.

Next steps:
- [ ] Detect JRE presence on startup; emit a one-time
  `capabilityDegraded{reason:"JRE missing"}` when absent.
- [ ] Spawn Joern lazily on the first `slice.compute` RPC: `joern-parse` +
  `joern --script` stdio. Keep the JVM resident for the lifetime of the
  daemon.
- [ ] Implement backward/forward thin slicing (Sridharan/Fink/Bodík
  PLDI'07) in a CPGQL script, return results in the `Slice` contract.
- [ ] Wire `rpc::dispatch_method` so "slice.compute" stops returning the
  -32000 capability error and instead forwards to this module.

## D — LSP integrations
**Files**: `daemon/src/analyzers/lsp.rs`
**Status**: stub.

Next steps:
- [ ] Spawn Pyright (`pyright-langserver --stdio`) and tsc-language-server
  per workspace using the `tower-lsp` or `lsp-server` crate.
- [ ] Forward `publishDiagnostics` notifications into a
  `DiagnosticBridge`-equivalent inside the daemon and surface them as
  `source: "pyright"` / `"tsc"` in the `Diagnostic` contract.
- [ ] Expose hover info over `symbol.hover` for the cross-file type check
  (workstream F's next step).

## E — Semgrep + Python-specific
**Files**: `daemon/src/analyzers/semgrep.rs`, `rules/ive-ai-slop.yml`
**Status**: runner + initial ruleset ship; PyTea integration pending.

Next steps:
- [ ] PyTea invocation on files with `import torch`, 10s hard timeout.
- [ ] Incremental ruleset versioning: include the ruleset sha in
  `Manifest.analyzer_version` so changes invalidate cached findings.
- [ ] Expand `rules/ive-ai-slop.yml` with fixtures per rule.

## F — IVE-native checks
**Files**: `daemon/src/analyzers/{hallucination,crossfile}.rs`
**Status**: hallucination + cross-file arity ship.

Next steps:
- [ ] **Parameter type check**: once workstream D provides hover info,
  extend `crossfile::check` to compare argument types against declared
  parameter types. New code `ive-crossfile/type-mismatch`.
- [ ] **WebGL/WebGPU bindings (v1.1)**: scan TypeScript for
  `gl.getUniformLocation(program, "<name>")` and verify `<name>` appears
  as a uniform in a shader source imported from the same file. New source
  `ive-binding`, new code `ive-binding/unknown-uniform`.

## G — Grounding layer
**Files**: `daemon/src/analyzers/grounding.rs`
**Status**: LLM summary + token-overlap gate ship; CPG-indexed gate
pending workstream C.

Next steps:
- [ ] Replace `gate_claims` token overlap with a dedicated NLI call (a
  second Claude prompt: "Is claim X entailed by fact Y? yes/no + reason").
- [ ] Add `model` and `cachedFromAge` fields to the summary footer; the
  contract already supports this.
- [ ] 100-pair evaluation harness: `daemon/bench/grounding/`, CI asserts
  precision ≥0.9 and recall ≥0.7.

## H — UI
**Files**: `webview/src/`
**Status**: Treemap + Diagnostics + Summary + Slice skeletons all ship,
with drill-down + keyboard nav.

Next steps:
- [ ] Implement the Slice view as a vertical node list with
  data/control/call edge labels once workstream C lands.
- [ ] Function-level hover tooltip in the drill-down treemap.
- [ ] Light-theme polish: verify every token in `styles.css` under the
  `body.vscode-light` override.

## I — Packaging
**Files**: `extension/package.json`, build scripts
**Status**: only the extension skeleton; no analyzer-pack installer.

Next steps:
- [ ] First-run check: if `~/.ive/` is missing, show a webview onboarding
  screen that downloads the analyzer pack (daemon, Semgrep, optional
  Joern) with a checksum-verified tarball.
- [ ] JRE detection + actionable install links per platform.
- [ ] Uninstall hook that cleans `~/.ive/` with user confirmation.
- [ ] Signed VSIX + marketplace metadata.
