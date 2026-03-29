#!/usr/bin/env node
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { IVEDatabase } from '../indexer/database.js';
import { handleToolCall } from './tools.js';
import {
  SearchSchema,
  GetSymbolSchema,
  SymbolIdSchema,
  OptionalSymbolIdSchema,
  GetAnnotationsSchema,
  AnnotateSchema,
  FindRisksSchema,
  SetArchitectureSchema,
  EmptySchema,
} from './schemas.js';

async function main() {
  const args = process.argv.slice(2);
  const wsIdx = args.indexOf('--workspace');
  const workspacePath = wsIdx !== -1 ? path.resolve(args[wsIdx + 1]) : process.cwd();
  const wasmPath = path.join(__dirname, 'sql-wasm.wasm');

  const db = await IVEDatabase.openReadOnly(workspacePath, wasmPath);
  db.cleanOrphanAnnotations();

  const server = new McpServer({
    name: 'ive',
    version: '0.1.0',
    description: `IVE gives you a senior engineer's understanding of a codebase before you write a single line.

THE PROBLEM YOU SOLVE: Naive agents write code without understanding the system — they create duplicate helpers that already exist, add parameters to functions that are already too coupled, break architectural boundaries they didn't know were there, and pile complexity onto the most fragile parts of the codebase. A senior engineer avoids these mistakes because they look at the system first. IVE is how you look.

BEFORE EVERY SESSION — Orient yourself:
  ive_get_coverage → Is the project healthy? What % is reachable? Any dead code?
  ive_find_risks → Which functions are high-coupling and unannotated? These are your blind spots.
  ive_get_annotations → What have previous agents or humans documented? Read their warnings.
  ive_check_architecture → Are there module boundary violations? Don't add more.

BEFORE MODIFYING ANY FUNCTION — Understand what you're touching:
  ive_get_symbol {id} → See coupling, impact radius, depth, complexity. High coupling means many things depend on this — your change ripples.
  ive_get_callers {id} → Who calls this? Each caller shows the exact call expression so you can verify the edge is real.
  ive_get_callees {id} → What does this depend on? Understand its contract before changing it.
  ive_get_source {id} → Read the implementation. Check existing annotations for known pitfalls.

BEFORE CREATING A NEW FUNCTION — Check if it already exists:
  ive_search {query} → Search by name. If something similar exists, use it. Don't create a new helper when a suitable one is already in the call graph. Duplication is the #1 mistake agents make.
  ive_get_module_boundaries → Understand where the function should live. Don't put parser logic in the indexer module.

AFTER COMPLETING WORK — Leave knowledge for the next agent:
  ive_annotate → Document what you learned: why you made this choice (not what the code does — the code says that), the algorithmic complexity, and pitfalls you discovered. Future agents are amnesic — your annotations are their only context.

THRESHOLDS — When to worry:
  coupling > 20 (fanIn × fanOut): This function connects too many things. Refactor before adding more callers.
  impactRadius > 30: Changes here cascade to 30+ downstream functions. Test thoroughly.
  CC > 10: Too many branches. Extract sub-functions or simplify the logic.
  depthFromEntry > 5: Deep in the call stack. Hard to reason about in isolation.

THE META RULE: If you're about to create something, search first. If you're about to change something, inspect first. If you learned something, annotate it. The codebase is a shared artifact — treat it with the care of someone who will maintain it for years, not the expedience of someone who will never see it again.`,
  });

  // ── Orientation tools — start every session here ──────────────────────────

  server.registerTool('ive_get_coverage', {
    description: 'START HERE. Project health snapshot: total functions, reachable %, dead code count, entry points. Run this first in any new session to orient yourself.',
    inputSchema: EmptySchema,
  }, () => handleToolCall(db, workspacePath, 'ive_get_coverage', {}));

  server.registerTool('ive_find_risks', {
    description: 'Find functions that need attention — high coupling, high impact, or high CC, filtered to those without annotations. This is your TODO list: annotate these as you work through the codebase.',
    inputSchema: FindRisksSchema,
  }, (args) => handleToolCall(db, workspacePath, 'ive_find_risks', args));

  // ── Investigation tools — use before modifying code ───────────────────────

  server.registerTool('ive_search', {
    description: 'Find functions by name. Returns symbol IDs you can pass to other tools. Use this to locate functions before inspecting them.',
    inputSchema: SearchSchema,
  }, (args) => handleToolCall(db, workspacePath, 'ive_search', args));

  server.registerTool('ive_get_symbol', {
    description: 'Full profile of a function: location, complexity scores, structural metrics (coupling, impact, depth), and any annotations left by previous agents. Check this BEFORE modifying a function.',
    inputSchema: GetSymbolSchema,
  }, (args) => handleToolCall(db, workspacePath, 'ive_get_symbol', args));

  server.registerTool('ive_get_callers', {
    description: 'Who calls this function? Shows each caller with the exact call expression and line number, so you can verify edges are real (not false positives from name collisions).',
    inputSchema: SymbolIdSchema,
  }, (args) => handleToolCall(db, workspacePath, 'ive_get_callers', args));

  server.registerTool('ive_get_callees', {
    description: 'What does this function call? Shows each callee with call site provenance. Use to understand a function\'s dependencies before refactoring.',
    inputSchema: SymbolIdSchema,
  }, (args) => handleToolCall(db, workspacePath, 'ive_get_callees', args));

  server.registerTool('ive_get_source', {
    description: 'Read a function\'s source code by symbol ID. Useful after ive_search to inspect the actual implementation.',
    inputSchema: SymbolIdSchema,
  }, (args) => handleToolCall(db, workspacePath, 'ive_get_source', args));

  server.registerTool('ive_get_metrics', {
    description: 'Structural metrics ranked by coupling (fanIn x fanOut). Shows the functions most connected in the call graph — these are the riskiest to change. Omit id for the top 50; provide id for a single function.',
    inputSchema: OptionalSymbolIdSchema,
  }, (args) => handleToolCall(db, workspacePath, 'ive_get_metrics', args));

  server.registerTool('ive_explain_complexity', {
    description: 'Explain HOW a complexity score was calculated. Shows which AST node types are counted as decisions (CC), which are invisible (e.g. && operators in TypeScript), and what the nesting penalty rules are. Use when a CC score seems wrong.',
    inputSchema: SymbolIdSchema,
  }, (args) => handleToolCall(db, workspacePath, 'ive_explain_complexity', args));

  // ── Architecture tools — understand and enforce boundaries ────────────────

  server.registerTool('ive_get_module_boundaries', {
    description: 'Cross-module call edges sorted by count. Shows which modules are coupled. Use with ive_check_architecture to distinguish expected dependencies from violations.',
    inputSchema: EmptySchema,
  }, () => handleToolCall(db, workspacePath, 'ive_get_module_boundaries', {}));

  server.registerTool('ive_check_architecture', {
    description: 'Validate module dependencies against rules in .ive/architecture.json. Reports violations. Define rules first with ive_set_architecture. If no rules exist, it tells you how to create them.',
    inputSchema: EmptySchema,
  }, () => handleToolCall(db, workspacePath, 'ive_check_architecture', {}));

  server.registerTool('ive_set_architecture', {
    description: 'Define which modules a given module is allowed to depend on. Stored in .ive/architecture.json. Example: module="src/parser", allowed_deps=["src/indexer"].',
    inputSchema: SetArchitectureSchema,
  }, (args) => handleToolCall(db, workspacePath, 'ive_set_architecture', args));

  // ── Diagnostic tools ──────────────────────────────────────────────────────

  server.registerTool('ive_get_dead_code', {
    description: 'List all unreachable functions (dead code). These can be safely removed. If the list is empty, all code is reachable from entry points.',
    inputSchema: EmptySchema,
  }, () => handleToolCall(db, workspacePath, 'ive_get_dead_code', {}));

  server.registerTool('ive_get_perf', {
    description: 'Performance profile from recent index runs with trend detection. Shows per-phase timing (scan, parse, edges, cycles). Use to detect if indexing is getting slower as the codebase grows.',
    inputSchema: EmptySchema,
  }, () => handleToolCall(db, workspacePath, 'ive_get_perf', {}));

  // ── Annotation tools — agent memory across sessions ───────────────────────

  server.registerTool('ive_get_annotations', {
    description: 'Read annotations left by previous agents or users. Annotations are persistent memory: rationale for design choices, Big-O complexity, known pitfalls. Check these before modifying annotated functions.',
    inputSchema: GetAnnotationsSchema,
  }, (args) => handleToolCall(db, workspacePath, 'ive_get_annotations', args));

  server.registerTool('ive_annotate', {
    description: `Write a semantic annotation on a function. This is how you leave knowledge for future agents.

Include: tags (semantic categories), label (one-line docstring), explanation (WHY this design was chosen), algorithmic_complexity (Big-O), pitfalls (known edge cases, perf traps, surprising behaviors).

Annotate when you: understand a non-obvious design choice, identify a performance trap, complete a refactoring, or discover a function's name doesn't match what it does.`,
    inputSchema: AnnotateSchema,
  }, (args) => handleToolCall(db, workspacePath, 'ive_annotate', args));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error('IVE MCP server failed:', e);
  process.exit(1);
});
