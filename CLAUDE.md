# IVE — Agent Guide for Working on IVE Itself

This project is self-referential: IVE is a code analysis engine, and you use IVE to analyze IVE. The MCP server (`ive_*` tools) should be your primary source of truth about the codebase — not this file.

## First: Use the Tools

```
ive_get_coverage        → Is the project healthy?
ive_find_risks          → What functions are high-risk and unannotated?
ive_get_annotations     → What did previous agents document?
ive_check_architecture  → Any module boundary violations?
ive_get_perf            → Is indexing performance regressing?
```

Before modifying any function:
```
ive_get_symbol {id}     → Coupling, impact, complexity, annotations
ive_get_callers {id}    → Who depends on this? (with call site provenance)
ive_get_callees {id}    → What does this depend on?
```

Before creating anything new:
```
ive_search {name}       → Does it already exist?
ive_get_module_boundaries → Where should it live?
```

After completing work:
```
ive_annotate            → Document what you learned (rationale, Big-O, spatial complexity, pitfalls)
```

Re-index after code changes:
```bash
node dist/ive-index.js --workspace .
```

## What IVE Is

A VSCode extension + MCP server that builds a call graph with structural metrics for any codebase. Nodes are functions/methods. Edges are call relationships (with provenance — the actual call expression text and line number). Everything lives in SQLite (`.ive/index.db`).

The human sees the graph in the VSCode sidebar. The agent sees the same data via 16 MCP tools. Both see: coverage, dead code, coupling, impact radius, module boundaries, architecture violations, annotations, and performance history.

## Build & Test

```bash
npm install && cd webview && npm install && cd ..
npm test                                    # 140 tests across 11 files
node esbuild.mjs                            # builds extension + MCP server + CLI
cd webview && npm run build && cd ..        # builds React frontend
node dist/ive-index.js --workspace .        # re-index IVE itself
```

## Project Structure

| Module | What | vscode-free? |
|--------|------|-------------|
| `src/indexer/database.ts` | SQLite via sql.js — symbols, edges, metrics, annotations, perf | Yes |
| `src/indexer/graphAnalyzer.ts` | Reachability, coupling, depth, impact, modules — pure functions | Yes |
| `src/indexer/cycleDetector.ts` | Iterative DFS cycle detection | Yes |
| `src/indexer/diffAnalyzer.ts` | Git diff parser | Yes |
| `src/indexer/IndexManager.ts` | Indexing orchestrator | No (vscode.workspace) |
| `src/parser/*.ts` | Tree-sitter AST analysis — symbols, edges, complexity | Yes (except TreeSitterParser) |
| `src/mcp/server.ts` | MCP stdio entry point — 16 tools | Yes |
| `src/mcp/tools.ts` | Tool handler dispatch map | Yes |
| `src/mcp/index-cli.ts` | CLI indexer (no VSCode) | Yes |
| `src/webview/IVEPanelProvider.ts` | Webview lifecycle + message dispatch | No (vscode.WebviewView) |
| `webview/src/` | React frontend | N/A (browser) |

The "vscode-free?" column matters because the MCP server and CLI indexer bundle only vscode-free modules. If you add a vscode import to a file in `src/indexer/` or `src/parser/`, the MCP server build will break.

## The Meta Game

IVE is built using IVE. When you change IVE:

1. Run `node dist/ive-index.js --workspace .` to re-index
2. Use `ive_get_coverage` and `ive_check_architecture` to verify you didn't break structural health
3. Use `ive_find_risks` to see if your changes created new high-coupling unannotated functions
4. Annotate what you built with `ive_annotate` — future agents (including future you) are amnesic

The self-audit test (`src/__tests__/selfAudit.test.ts`) validates that IVE's own call graph meets structural health thresholds. If you break the architecture, the test tells you.

## Annotations Are Memory

Annotations are the only persistent metadata agents can write. They survive across sessions. When you understand something non-obvious — why a design choice was made, what the Big-O is, what will break if you change this — write an annotation. The annotation schema:

- `tags` — semantic categories for filtering
- `label` — one-line docstring
- `explanation` — WHY, not what
- `algorithmic_complexity` — Big-O time
- `spatial_complexity` — data movement estimate ("copies full array", "streams line-by-line")
- `pitfalls` — concrete traps you discovered

Annotations can target symbols (functions), modules, or the project itself.

## Self-Diagnosis

Don't trust this file for limitations — use the tools to discover them:

| Question | Tool |
|----------|------|
| Are there false-positive edges? | `ive_get_callers` — call site text proves the edge |
| Is a CC score wrong? | `ive_explain_complexity` — shows what node types count |
| Which functions need docs? | `ive_find_risks` — unannotated high-coupling functions |
| Architecture degrading? | `ive_check_architecture` — validates against rules |
| Indexing getting slower? | `ive_get_perf` — history with trend detection |

What IVE genuinely cannot see (no data collected): dynamic calls, type-level edges, decorator/macro effects, runtime performance, test coverage correlation.
