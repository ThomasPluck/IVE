<p align="center">
  <img src="resources/ive_logo.png" alt="IVE" width="128" />
</p>

<h1 align="center">IVE - Interactive Vibing Environment</h1>

<p align="center">
  <a href="https://github.com/ThomasPluck/IVE/actions/workflows/build.yml"><img src="https://github.com/ThomasPluck/IVE/actions/workflows/build.yml/badge.svg" alt="Build VSIX" /></a>
</p>

<p align="center"><strong>A structural analysis engine for codebases.<br/>Gives humans a visual map and gives AI agents a reasoning API.</strong></p>

IVE builds a call graph of your project with structural metrics — complexity, coupling, impact radius, reachability, module boundaries — and exposes it through both a VSCode sidebar and an MCP server that any Claude Code agent can query.

The idea: AI writes millions of lines of code. Subtle structural issues — false dependencies, dead code, coupling creep, architectural violations — are invisible unless you have a bird's-eye view. IVE provides that view for both humans and agents.

## What You See

**VSCode Sidebar** — interactive call graph with:
- Nodes colored by cyclomatic complexity (green → red)
- Badges for high churn (amber), coupling (purple), impact (blue), cycles (↺)
- Dead code shown with dashed red borders
- Click any node → detail panel with full metrics, callers/callees with call site provenance, and annotations
- Coverage panel: reachable %, dead code count, module count, architecture pass/fail, annotation coverage, index performance

**Node Detail Panel** — click any function to see:
- Complexity scores (CC, cognitive, LOC, params, loop depth) with warning highlights
- Structural metrics (fan-in, fan-out, coupling, depth from entry, impact radius)
- All callers and callees with exact call expressions and line numbers
- Semantic annotations left by agents or humans (rationale, Big-O, spatial complexity, pitfalls)

## What Agents See

**MCP Server** — 16 tools automatically available to Claude Code:

| Tool | Purpose |
|------|---------|
| `ive_get_coverage` | Project health: reachable %, dead code, entry points |
| `ive_find_risks` | Unannotated high-coupling functions needing attention |
| `ive_search` | Find functions by name |
| `ive_get_symbol` | Full function profile with metrics + annotations |
| `ive_get_callers` / `ive_get_callees` | Dependency graph with call site provenance |
| `ive_get_source` | Read function source by ID |
| `ive_get_metrics` | Top functions ranked by coupling |
| `ive_explain_complexity` | How CC was calculated — what counts, what doesn't |
| `ive_check_architecture` / `ive_set_architecture` | Module dependency rules and validation |
| `ive_get_module_boundaries` | Cross-module call edges |
| `ive_get_dead_code` | All unreachable functions |
| `ive_get_perf` | Index performance history with trends |
| `ive_annotate` | Write semantic annotations (agent memory across sessions) |
| `ive_get_annotations` | Read annotations |

The MCP server description teaches agents an engineering workflow: orient first, inspect before modifying, search before creating, annotate what you learn.

## Languages

TypeScript, TSX, JavaScript, Python, Rust, Go — powered by tree-sitter WASM grammars.

## Getting Started

```bash
# Install
npm install
cd webview && npm install && cd ..

# Build everything (extension + MCP server + CLI indexer + webview)
npm run build

# Run tests (140 tests across 11 files)
npm test

# Index a workspace from CLI (no VSCode needed)
node dist/ive-index.js --workspace /path/to/project

# Press F5 in VSCode to launch Extension Development Host
```

When you install the extension and open a workspace:
1. IVE indexes the project (tree-sitter parse → symbols → call graph → metrics → cycles)
2. The sidebar shows the interactive graph with all structural data
3. IVE registers its MCP server in `~/.claude.json` for Claude Code auto-discovery
4. Next Claude Code session in that workspace gets all 16 `ive_*` tools

## How It Works

```
Your Code → tree-sitter AST → symbols + call edges → SQLite (.ive/index.db)
                                                           ↓
                                              ┌────────────┼────────────┐
                                              ↓            ↓            ↓
                                        VSCode Webview  MCP Server  CLI Indexer
                                        (human view)   (agent view) (CI/scripts)
```

**Everything lives in SQLite.** Symbols, edges, metrics, annotations, architecture rules, performance history — one database, three interfaces.

**Incremental indexing.** Files are hashed; unchanged files skip parsing entirely. On a warm re-index with no changes, IVE returns immediately.

**Self-referential.** IVE uses its own analysis to improve itself. The test suite includes a self-audit that validates IVE's structural health against its own metrics.

## Architecture

| Module | Purpose |
|--------|---------|
| `src/indexer/` | Database, graph analyzer, cycle detector, diff analyzer, git churn |
| `src/parser/` | Tree-sitter AST parsing, symbol extraction, call graph, complexity |
| `src/mcp/` | MCP server (agent interface), CLI indexer, tool handlers |
| `src/webview/` | VSCode panel provider (human interface) |
| `webview/src/` | React frontend — graph, coverage panel, node detail panel |

## License

MIT
