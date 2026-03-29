import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { IVEDatabase } from '../indexer/database.js';
import type { GraphNode } from '../types.js';
import { detectModuleBoundaries } from '../indexer/graphAnalyzer.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type Args = Record<string, unknown>;
type Ctx = { db: IVEDatabase; ws: string };

function text(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }] };
}

/** Append enforcement warnings to any tool response. */
function withEnforcement(ctx: Ctx, result: ToolResult): ToolResult {
  const warnings: string[] = [];

  const unannotatedNodes = ctx.db.getUnannotatedSymbolCount();
  if (unannotatedNodes > 0) warnings.push(`${unannotatedNodes} unannotated functions`);

  const unannotatedEdges = ctx.db.getUnannotatedEdgeCount();
  if (unannotatedEdges > 0) warnings.push(`${unannotatedEdges} unannotated edges`);

  // Diff discipline check
  try {
    const diffStat = execSync('git diff --shortstat', { cwd: ctx.ws, encoding: 'utf-8', timeout: 3000 }).trim();
    if (diffStat) {
      const linesMatch = diffStat.match(/(\d+) insertion|(\d+) deletion/g);
      const totalLines = (linesMatch ?? []).reduce((sum, m) => sum + parseInt(m), 0);
      if (totalLines > 500) warnings.push(`large uncommitted diff (${totalLines} lines) — document changes via ive_annotate`);
    }
  } catch { /* not a git repo or no changes */ }

  if (warnings.length === 0) return result;
  const banner = `\n\n--- Enforcement ---\n${warnings.map(w => `⚠ ${w}`).join('\n')}`;
  return { content: [{ type: 'text', text: result.content[0].text + banner }] };
}

function err(message: string): ToolResult {
  return text(`Error: ${message}`);
}

function rel(filePath: string, ws: string): string {
  return path.relative(ws, filePath).replace(/\\/g, '/');
}

function fmt(n: GraphNode, ws: string): string {
  return `${n.name} (${n.kind}) — ${rel(n.filePath, ws)}:${n.line}  [${n.loc}L CC=${n.complexity ?? '?'}]`;
}

function fmtList(nodes: GraphNode[], ws: string): string {
  return nodes.map(n => `  [${n.id}] ${fmt(n, ws)}`).join('\n');
}

// ── Handlers ─────────────────────────────────────────────────────────────────

function handleSearch({ db, ws }: Ctx, args: Args): ToolResult {
  const query = args.query as string;
  if (!query) return err('query is required');
  const result = db.searchSymbols(query);
  if (result.nodes.length === 0) return text(`No symbols matching "${query}".`);
  return text(`Found ${result.nodes.length} symbols matching "${query}":\n\n${fmtList(result.nodes, ws)}`);
}

function handleGetSymbol({ db, ws }: Ctx, args: Args): ToolResult {
  const id = args.id as number | undefined;
  const name = args.name as string | undefined;
  if (!id && !name) return err('provide id or name');

  if (id) {
    const node = db.getSymbolById(id);
    if (!node) return err(`symbol ${id} not found`);
    const metrics = db.getStructuralMetrics();
    const m = metrics.get(id);
    const annotations = db.getAnnotations({ symbolId: id });

    let out = `=== ${node.name} ===\n`;
    out += `Kind: ${node.kind}  |  ${rel(node.filePath, ws)}:${node.line}-${node.endLine}\n`;
    out += `LOC: ${node.loc}  CC: ${node.complexity ?? '?'}  Cognitive: ${node.cognitiveComplexity ?? '?'}  Params: ${node.parameterCount ?? '?'}  Loop depth: ${node.maxLoopDepth ?? '?'}\n`;
    if (m) {
      out += `Fan-in: ${m.fanIn}  Fan-out: ${m.fanOut}  Coupling: ${m.coupling}  Depth: ${m.depthFromEntry}  Impact: ${m.impactRadius}  Module: ${m.module}\n`;
      if (m.isDeadCode) out += `⚠ DEAD CODE — unreachable from entry points\n`;
    }
    if (node.churnCount != null) out += `Churn: ${node.churnCount} commits (${node.recentChurnCount ?? 0} recent)\n`;

    // Test coverage
    if (db.isSymbolTested(id)) {
      out += `Tests: COVERED\n`;
    } else {
      out += `Tests: NOT COVERED — no test exercises this function\n`;
    }

    if (annotations.length > 0) {
      out += `\nAnnotations:\n`;
      for (const a of annotations) {
        out += `  [${a.tags.join(', ')}] ${a.label}\n`;
        out += `    Rationale: ${a.explanation}\n`;
        if (a.algorithmicComplexity) out += `    Complexity: ${a.algorithmicComplexity}\n`;
        if (a.spatialComplexity) out += `    Spatial: ${a.spatialComplexity}\n`;
        if (a.pitfalls.length > 0) out += `    Pitfalls: ${a.pitfalls.join('; ')}\n`;
      }
    } else {
      out += `\n⚠ No annotations — use ive_annotate to document this function\n`;
    }
    return text(out);
  }

  const matches = db.searchSymbols(name!);
  if (matches.nodes.length === 0) return err(`no symbol named "${name}"`);
  return text(`Symbols matching "${name}":\n\n${fmtList(matches.nodes, ws)}`);
}

function fmtCallList(db: IVEDatabase, nodes: Array<GraphNode & { callLine?: number; callText?: string }>, sourceOrTargetId: number, direction: 'caller' | 'callee', ws: string): string {
  return nodes.map(n => {
    let line = `  [${n.id}] ${fmt(n, ws)}`;
    if (n.callLine || n.callText) {
      line += `\n        call site: line ${n.callLine ?? '?'}: ${n.callText ?? '(unknown)'}`;
    }
    // Show edge annotation if it exists
    const edgeSourceId = direction === 'caller' ? n.id : sourceOrTargetId;
    const edgeTargetId = direction === 'caller' ? sourceOrTargetId : n.id;
    const edgeId = db.getEdgeIdBetween(edgeSourceId, edgeTargetId);
    if (edgeId) {
      const edgeAnns = db.getAnnotations({ edgeId });
      if (edgeAnns.length > 0) {
        line += `\n        edge: [${edgeAnns[0].tags.join(', ')}] ${edgeAnns[0].label}`;
      }
    }
    return line;
  }).join('\n');
}

function handleGetCallers({ db, ws }: Ctx, args: Args): ToolResult {
  const id = args.id as number;
  if (!id) return err('id is required');
  const target = db.getSymbolById(id);
  const callers = db.getCallers(id);
  const header = target ? `Callers of ${target.name} (id=${id}):` : `Callers of id=${id}:`;
  if (callers.length === 0) return text(`${header}\n  (none — this is an entry point)`);
  return text(`${header}\n\n${fmtCallList(db, callers, id, 'caller', ws)}`);
}

function handleGetCallees({ db, ws }: Ctx, args: Args): ToolResult {
  const id = args.id as number;
  if (!id) return err('id is required');
  const source = db.getSymbolById(id);
  const callees = db.getCallees(id);
  const header = source ? `Callees of ${source.name} (id=${id}):` : `Callees of id=${id}:`;
  if (callees.length === 0) return text(`${header}\n  (none — this is a leaf function)`);
  return text(`${header}\n\n${fmtCallList(db, callees, id, 'callee', ws)}`);
}

function handleGetMetrics({ db, ws }: Ctx, args: Args): ToolResult {
  const id = args.id as number | undefined;
  const metrics = db.getStructuralMetrics();

  if (id) {
    const m = metrics.get(id);
    if (!m) return err(`symbol ${id} not found`);
    const node = db.getSymbolById(id);
    return text(
      `Metrics for ${node?.name ?? `id=${id}`}:\n` +
      `  Fan-in: ${m.fanIn}  Fan-out: ${m.fanOut}  Coupling: ${m.coupling}\n` +
      `  Depth from entry: ${m.depthFromEntry}  Impact radius: ${m.impactRadius}\n` +
      `  Module: ${m.module}  Dead: ${m.isDeadCode}`
    );
  }

  const sorted = [...metrics.values()].sort((a, b) => b.coupling - a.coupling).slice(0, 50);
  const lines = sorted.map(m => {
    const node = db.getSymbolById(m.id);
    const name = (node?.name ?? '?').padEnd(30);
    const file = node ? rel(node.filePath, ws) : '?';
    return `${String(m.coupling).padStart(4)}c  ${String(m.fanIn).padStart(2)}in ${String(m.fanOut).padStart(2)}out  imp=${String(m.impactRadius).padStart(3)}  d=${m.depthFromEntry}  CC=${String(node?.complexity ?? '?').padStart(2)}  ${name} ${file}`;
  });
  return text(`Top ${sorted.length} functions by coupling (fanIn × fanOut):\n\n${lines.join('\n')}`);
}

function handleGetCoverage({ db, ws }: Ctx): ToolResult {
  const cov = db.getProjectCoverage();
  const testStats = db.getTestCoverageStats();
  const unannotatedNodes = db.getUnannotatedSymbolCount();
  const unannotatedEdges = db.getUnannotatedEdgeCount();

  let out = `=== Project Coverage ===\n`;
  out += `Total functions:  ${cov.totalFunctions}\n`;
  out += `Reachable:        ${cov.reachableCount} (${cov.coveragePercent}%)\n`;
  out += `Dead code:        ${cov.deadCodeIds.length}\n`;
  out += `Entry points:     ${cov.entryPointIds.length}\n`;
  out += `Test coverage:    ${testStats.tested}/${testStats.total} functions (${testStats.total > 0 ? Math.round((testStats.tested / testStats.total) * 100) : 0}%)\n`;
  out += `Annotated nodes:  ${cov.totalFunctions - unannotatedNodes}/${cov.totalFunctions}`;
  if (unannotatedNodes > 0) out += ` — ${unannotatedNodes} need annotations`;
  out += `\nAnnotated edges:  ${(db.getAllEdges().length) - unannotatedEdges}/${db.getAllEdges().length}`;
  if (unannotatedEdges > 0) out += ` — ${unannotatedEdges} need annotations`;
  out += `\n`;

  // Diff size warning
  try {
    const diffStat = execSync('git diff --shortstat', { cwd: ws, encoding: 'utf-8', timeout: 3000 }).trim();
    if (diffStat) out += `\nUncommitted: ${diffStat}\n`;
  } catch { /* not git */ }

  if (cov.deadCodeIds.length > 0) {
    out += `\nDead functions:\n`;
    for (const id of cov.deadCodeIds.slice(0, 20)) {
      const n = db.getSymbolById(id);
      if (n) out += `  [${id}] ${fmt(n, ws)}\n`;
    }
    if (cov.deadCodeIds.length > 20) out += `  ... and ${cov.deadCodeIds.length - 20} more\n`;
  }
  return text(out);
}

function handleGetDeadCode({ db, ws }: Ctx): ToolResult {
  const coverage = db.getProjectCoverage();
  if (coverage.deadCodeIds.length === 0) return text('No dead code found. All functions are reachable from entry points.');
  const nodes = coverage.deadCodeIds.map(id => db.getSymbolById(id)).filter((n): n is GraphNode => n !== null);
  return text(`${coverage.deadCodeIds.length} unreachable functions (${coverage.coveragePercent}% coverage):\n\n${fmtList(nodes, ws)}`);
}

function handleGetModuleBoundaries({ db }: Ctx): ToolResult {
  const edges = db.getAllEdges();
  const metrics = db.getStructuralMetrics();
  const moduleMap = new Map<number, string>();
  for (const [id, m] of metrics) moduleMap.set(id, m.module);
  const boundaries = detectModuleBoundaries(edges, moduleMap);
  if (boundaries.length === 0) return text('No cross-module edges found.');
  const lines = boundaries.map(b => `${String(b.edgeCount).padStart(3)} edges: ${b.sourceModule} → ${b.targetModule}`);
  return text(`Cross-module call edges (sorted by count):\n\n${lines.join('\n')}`);
}

function handleGetAnnotations({ db }: Ctx, args: Args): ToolResult {
  const symbolId = args.symbolId as number | undefined;
  const annotations = db.getAnnotations(symbolId !== undefined ? { symbolId } : undefined);
  if (annotations.length === 0) return text(symbolId ? `No annotations for symbol ${symbolId}.` : 'No annotations yet.');
  const lines = annotations.map(a => {
    const n = db.getSymbolById(a.symbolId);
    let s = `[${a.symbolId}] ${n?.name ?? '?'}: [${a.tags.join(', ')}] ${a.label}`;
    s += `\n    Rationale: ${a.explanation}`;
    if (a.algorithmicComplexity) s += `\n    Complexity: ${a.algorithmicComplexity}`;
    if (a.pitfalls.length > 0) s += `\n    Pitfalls: ${a.pitfalls.join('; ')}`;
    return s;
  });
  return text(`Annotations:\n\n${lines.join('\n\n')}`);
}

function handleGetSource({ db, ws }: Ctx, args: Args): ToolResult {
  const id = args.id as number;
  if (!id) return err('id is required');
  const info = db.getSymbolInfo(id);
  if (!info) return err(`symbol ${id} not found`);
  try {
    const content = fs.readFileSync(info.filePath, 'utf-8');
    const lines = content.split('\n');
    const source = lines.slice(info.startLine - 1, info.endLine).join('\n');
    return text(`=== ${info.name} ===\n${rel(info.filePath, ws)}:${info.startLine}-${info.endLine} (${info.language})\n\n${source}`);
  } catch {
    return text(`Could not read source for ${info.name} at ${info.filePath}`);
  }
}

function handleAnnotate({ db }: Ctx, args: Args): ToolResult {
  const symbolId = args.symbolId as number | undefined;
  const edgeId = args.edgeId as number | undefined;
  const targetType = (args.target_type as string) ?? (edgeId ? 'edge' : 'symbol');
  const targetName = (args.target_name as string) ?? '';

  if (!symbolId && !edgeId && targetType === 'symbol') return err('symbolId is required for symbol annotations');
  if (!edgeId && targetType === 'edge') return err('edgeId is required for edge annotations');

  const annotation = db.upsertAnnotation({
    symbolId: symbolId ?? null,
    edgeId: edgeId ?? null,
    targetType: targetType as 'symbol' | 'module' | 'project' | 'edge',
    targetName,
    tags: (args.tags as string[]) ?? [],
    label: (args.label as string) ?? '',
    explanation: (args.explanation as string) ?? '',
    author: (args.author as string) ?? 'agent',
    algorithmicComplexity: (args.algorithmic_complexity as string) ?? '',
    spatialComplexity: (args.spatial_complexity as string) ?? '',
    pitfalls: (args.pitfalls as string[]) ?? [],
  });

  let name = targetName;
  if (symbolId) {
    const n = db.getSymbolById(symbolId);
    name = n?.name ?? `id=${symbolId}`;
  }

  let out = `Annotated ${annotation.targetType}:${name}: [${annotation.tags.join(', ')}] ${annotation.label}`;
  if (annotation.algorithmicComplexity) out += `\n  Algo complexity: ${annotation.algorithmicComplexity}`;
  if (annotation.spatialComplexity) out += `\n  Spatial complexity: ${annotation.spatialComplexity}`;
  if (annotation.pitfalls.length > 0) out += `\n  Pitfalls: ${annotation.pitfalls.join('; ')}`;
  return text(out);
}

function handleGetPerf({ db }: Ctx): ToolResult {
  const runs = db.getPerfHistory(10);
  if (runs.length === 0) return text('No perf data yet. Index the workspace first (via VSCode extension or CLI).');

  const lines = runs.map(r => {
    const date = new Date(r.timestamp).toLocaleString();
    const phases = r.phases.map(p => `${p.name}=${p.ms}ms`).join(' ');
    const changed = r.skipped ? 'skipped' : `${r.changedFiles} changed`;
    return `  ${date}  ${String(r.totalMs).padStart(5)}ms  ${r.totalFiles} files (${changed})  [${phases}]`;
  });

  let out = `=== Index Performance (last ${runs.length} runs) ===\n\n${lines.join('\n')}`;

  if (runs.length >= 2) {
    const getPhase = (r: typeof runs[0], name: string) => r.phases.find(p => p.name === name)?.ms;
    const newest = getPhase(runs[0], 'edges+metrics');
    const oldest = getPhase(runs[runs.length - 1], 'edges+metrics');
    if (newest && oldest && oldest > 0) {
      const pct = Math.round(((newest - oldest) / oldest) * 100);
      out += `\n\nTrend: edges+metrics ${pct > 0 ? `+${pct}% slower` : `${pct}% faster`} (${oldest}ms → ${newest}ms)`;
    }
  }

  return text(out);
}

function handleExplainComplexity({ db, ws }: Ctx, args: Args): ToolResult {
  const id = args.id as number;
  if (!id) return err('id is required');
  const node = db.getSymbolById(id);
  if (!node) return err(`symbol ${id} not found`);

  const { getLanguageConfig } = require('../parser/languages.js');
  const config = getLanguageConfig(node.language);
  if (!config) return err(`no language config for ${node.language}`);

  let out = `=== Complexity Explanation: ${node.name} ===\n`;
  out += `${rel(node.filePath, ws)}:${node.line}-${node.endLine} (${node.language})\n\n`;
  out += `Scores:\n`;
  out += `  Cyclomatic: ${node.complexity ?? '?'} (1 base + decision points)\n`;
  out += `  Cognitive:  ${node.cognitiveComplexity ?? '?'} (decisions weighted by nesting depth)\n`;
  out += `  Params:     ${node.parameterCount ?? '?'}\n`;
  out += `  Loop depth: ${node.maxLoopDepth ?? '?'}\n\n`;

  out += `Language config (${node.language}):\n`;
  out += `  Decision nodes (counted for CC): ${config.decisionNodeTypes.join(', ')}\n`;
  out += `  Loop nodes (counted for depth): ${config.loopNodeTypes.join(', ')}\n`;
  out += `  Call expressions: ${config.callExpressionTypes.join(', ')}\n`;
  out += `  Parameter field: ${config.parameterListField}\n\n`;

  out += `NOT counted for ${node.language}:\n`;
  const notCounted = ['binary_expression', 'boolean_operator'].filter(t => !config.decisionNodeTypes.includes(t));
  if (notCounted.length > 0) {
    out += `  ${notCounted.join(', ')} — logical operators (&&, ||) in these node types are invisible to CC\n`;
  }

  out += `\nNesting increasers (cognitive penalty): if, for, for_in, while, do, switch, catch, function, arrow_function, function_definition\n`;
  out += `  Each nesting level adds +level to the cognitive score of inner decisions\n`;

  return text(out);
}

function handleCheckArchitecture({ db }: Ctx): ToolResult {
  // Architecture rules are stored as module-level annotations with tag 'architecture'
  const archAnnotations = db.getAnnotations({ targetType: 'module' })
    .filter(a => a.tags.includes('architecture'));

  if (archAnnotations.length === 0) {
    return text(
      'No architecture rules defined yet.\n\n' +
      'Use ive_set_architecture to define allowed dependencies per module:\n' +
      '  ive_set_architecture { module: "src/parser", allowed_deps: ["src/indexer"] }'
    );
  }

  const rules = new Map<string, string[]>();
  for (const a of archAnnotations) {
    try { rules.set(a.targetName, JSON.parse(a.explanation)); } catch { /* skip malformed */ }
  }

  const edges = db.getAllEdges();
  const metrics = db.getStructuralMetrics();
  const moduleMap = new Map<number, string>();
  for (const [id, m] of metrics) moduleMap.set(id, m.module);

  const boundaries = detectModuleBoundaries(edges, moduleMap);
  const violations: Array<{ from: string; to: string; count: number }> = [];
  const compliant: string[] = [];

  for (const b of boundaries) {
    const allowed = rules.get(b.sourceModule);
    if (!allowed) continue;
    if (allowed.includes(b.targetModule)) {
      compliant.push(`${b.sourceModule} → ${b.targetModule} (${b.edgeCount} edges)`);
    } else {
      violations.push({ from: b.sourceModule, to: b.targetModule, count: b.edgeCount });
    }
  }

  if (violations.length === 0) {
    return text(`=== Architecture Check: PASS ===\n\n${compliant.length} compliant boundaries.\nNo violations found.`);
  }

  const vLines = violations.map(v => `  ${v.from} → ${v.to} (${v.count} edges) — NOT in allowed_deps`);
  return text(`=== Architecture Check: ${violations.length} VIOLATIONS ===\n\n${vLines.join('\n')}\n\n${compliant.length} compliant boundaries.`);
}

function handleSetArchitecture({ db }: Ctx, args: Args): ToolResult {
  const module = args.module as string;
  const allowedDeps = args.allowed_deps as string[];
  if (!module || !allowedDeps) return err('module and allowed_deps are required');

  db.upsertAnnotation({
    targetType: 'module',
    targetName: module,
    tags: ['architecture'],
    label: `Allowed deps: ${allowedDeps.join(', ')}`,
    explanation: JSON.stringify(allowedDeps),
    author: 'agent',
  });

  return text(`Set architecture rule: ${module} → [${allowedDeps.join(', ')}]`);
}

function handleFindRisks({ db, ws }: Ctx, args: Args): ToolResult {
  const minCoupling = (args.min_coupling as number) ?? 10;
  const minImpact = (args.min_impact as number) ?? 20;
  const minCc = (args.min_cc as number) ?? 0;
  const unannotatedOnly = (args.unannotated_only as boolean) ?? true;

  const metrics = db.getStructuralMetrics();
  const annotatedIds = new Set(db.getAnnotations()?.map(a => a.symbolId).filter((id): id is number => id !== null) ?? []);

  const risks: Array<{ node: GraphNode; coupling: number; impact: number }> = [];
  for (const [id, m] of metrics) {
    if (unannotatedOnly && annotatedIds.has(id)) continue;
    const meetsThreshold = m.coupling >= minCoupling || m.impactRadius >= minImpact;
    if (!meetsThreshold) continue;
    const node = db.getSymbolById(id);
    if (!node) continue;
    if (minCc > 0 && (node.complexity ?? 0) < minCc) continue;
    risks.push({ node, coupling: m.coupling, impact: m.impactRadius });
  }

  risks.sort((a, b) => b.coupling - a.coupling);
  if (risks.length === 0) return text('No high-risk unannotated functions found matching thresholds.');

  const shown = risks.slice(0, 30);
  const lines = shown.map(r =>
    `  [${r.node.id}] coupling=${r.coupling} impact=${r.impact} CC=${r.node.complexity ?? '?'}  ${r.node.name}  ${rel(r.node.filePath, ws)}`
  );
  const suffix = unannotatedOnly ? ' (unannotated only)' : '';
  let out = `${risks.length} functions with coupling >= ${minCoupling} or impact >= ${minImpact}${suffix}:`;
  if (risks.length > 30) out += ` (showing top 30)`;
  return text(`${out}\n\n${lines.join('\n')}`);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

const HANDLERS: Record<string, (ctx: Ctx, args: Args) => ToolResult> = {
  ive_search: handleSearch,
  ive_get_symbol: handleGetSymbol,
  ive_get_callers: handleGetCallers,
  ive_get_callees: handleGetCallees,
  ive_get_metrics: handleGetMetrics,
  ive_get_coverage: handleGetCoverage,
  ive_get_dead_code: handleGetDeadCode,
  ive_get_module_boundaries: handleGetModuleBoundaries,
  ive_get_annotations: handleGetAnnotations,
  ive_get_source: handleGetSource,
  ive_annotate: handleAnnotate,
  ive_get_perf: handleGetPerf,
  ive_find_risks: handleFindRisks,
  ive_explain_complexity: handleExplainComplexity,
  ive_check_architecture: handleCheckArchitecture,
  ive_set_architecture: handleSetArchitecture,
};

export function handleToolCall(
  db: IVEDatabase,
  workspacePath: string,
  name: string,
  args: Record<string, unknown>
): ToolResult {
  db.reloadIfChanged();
  const ctx = { db, ws: workspacePath };
  const handler = HANDLERS[name];
  if (!handler) return err(`unknown tool: ${name}`);
  const result = handler(ctx, args);
  return withEnforcement(ctx, result);
}
