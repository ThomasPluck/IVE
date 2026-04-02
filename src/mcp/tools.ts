import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { IVEDatabase } from '../indexer/database.js';
import type { GraphNode } from '../types.js';
import {
  detectModuleBoundaries,
  findCallPath,
  findCallPathUndirected,
  getNeighborhood,
  getConnectedComponent,
  findDeepestChains,
} from '../indexer/graphAnalyzer.js';
import { writeViewerCommand } from './viewerCommands.js';

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

// ── Path finding ────────────────────────────────────────────────────────────

/** Format a forward path as indented text. */
function fmtPath(db: IVEDatabase, pathIds: number[], ws: string): string {
  return pathIds.map((id, i) => {
    const n = db.getSymbolById(id);
    if (!n) return `  [${id}] ???`;
    const arrow = i < pathIds.length - 1 ? ' →' : '';
    return `  ${'  '.repeat(i)}${n.name} (id=${id}, ${n.kind}) — ${rel(n.filePath, ws)}:${n.line}${arrow}`;
  }).join('\n');
}

/** Diagnose why no direct call path exists between two nodes. */
function diagnoseNoPath(db: IVEDatabase, edges: Array<{sourceId: number; targetId: number}>, fromId: number, toId: number, fromNode: GraphNode, toNode: GraphNode, ws: string): string {
  let out = `No direct call path from ${fromNode.name} (id=${fromId}) to ${toNode.name} (id=${toId}).\n`;

  // Check reverse direction
  const reversePath = findCallPath(edges, toId, fromId);
  if (reversePath) {
    out += `\nReverse path exists (${toNode.name} → ${fromNode.name}, ${reversePath.length} steps):\n`;
    out += fmtPath(db, reversePath, ws);
    out += `\n`;
  }

  // Try undirected path
  const undirected = findCallPathUndirected(edges, fromId, toId);
  if (undirected) {
    const steps = undirected.path.map((id, i) => {
      const n = db.getSymbolById(id);
      const name = n?.name ?? '???';
      if (i === 0) return name;
      const dir = undirected.directions[i - 1] === 'forward' ? '→' : '←';
      return `${dir} ${name}`;
    }).join(' ');
    out += `\nUndirected connection (${undirected.path.length} steps, ignoring edge direction):\n  ${steps}\n`;
  } else {
    // They're in separate subgraphs
    const comp1 = getConnectedComponent(edges, fromId);
    const comp2 = getConnectedComponent(edges, toId);
    out += `\nThese are in separate subgraphs (${comp1.size} and ${comp2.size} nodes respectively). No connection exists even ignoring edge direction.\n`;
  }

  // Show modules
  const metrics = db.getStructuralMetrics();
  const fromMod = metrics.get(fromId)?.module ?? '?';
  const toMod = metrics.get(toId)?.module ?? '?';
  if (fromMod !== toMod) {
    out += `\nModules: ${fromMod} → ${toMod}`;
  }

  return out;
}

function handleFindPath({ db, ws }: Ctx, args: Args): ToolResult {
  const fromId = args.from_id as number;
  const toId = args.to_id as number;
  if (fromId == null || toId == null) return err('from_id and to_id are required');

  const fromNode = db.getSymbolById(fromId);
  const toNode = db.getSymbolById(toId);
  if (!fromNode) return err(`symbol ${fromId} not found`);
  if (!toNode) return err(`symbol ${toId} not found`);

  const edges = db.getAllEdges();
  const path = findCallPath(edges, fromId, toId);

  if (!path) return text(diagnoseNoPath(db, edges, fromId, toId, fromNode, toNode, ws));

  return text(`Call path (${path.length} steps):\n\n${fmtPath(db, path, ws)}`);
}

// ── Name resolution ────────────────────────────────────────────────────────

/**
 * Resolve a function name to a single symbol ID.
 * Supports "name@file" syntax to disambiguate (e.g. "setupListener@ViewportSync").
 * When ambiguous, falls back to highest-coupling match instead of erroring.
 */
function resolveNameToId(db: IVEDatabase, name: string, ws: string): { id: number; node: GraphNode } | ToolResult {
  // Support "name@file" syntax: name@partial/path filters by file path
  let searchName = name;
  let fileFilter: string | null = null;
  const atIdx = name.lastIndexOf('@');
  if (atIdx > 0) {
    searchName = name.slice(0, atIdx);
    fileFilter = name.slice(atIdx + 1);
  }

  const results = db.searchSymbols(searchName);
  let candidates = results.nodes.filter(n => n.name === searchName);

  // Apply file filter if provided
  if (fileFilter && candidates.length > 0) {
    const filtered = candidates.filter(n => n.filePath.includes(fileFilter!));
    if (filtered.length > 0) candidates = filtered;
  }

  if (candidates.length === 1) return { id: candidates[0].id, node: candidates[0] };

  if (candidates.length > 1) {
    // Fall back to highest coupling instead of erroring
    const metrics = db.getStructuralMetrics();
    candidates.sort((a, b) => (metrics.get(b.id)?.coupling ?? 0) - (metrics.get(a.id)?.coupling ?? 0));
    const picked = candidates[0];
    const others = candidates.slice(1, 4).map(n => {
      const c = metrics.get(n.id)?.coupling ?? 0;
      return `  ${n.name} (id=${n.id}, coupling=${c}) — ${rel(n.filePath, ws)}:${n.line}`;
    }).join('\n');
    const pickedCoupling = metrics.get(picked.id)?.coupling ?? 0;
    // Return the highest-coupling match with a note about alternatives
    return {
      id: picked.id,
      node: picked,
      note: `Resolved "${searchName}" to highest-coupling match: ${picked.name} (id=${picked.id}, coupling=${pickedCoupling}) — ${rel(picked.filePath, ws)}:${picked.line}\nOther matches:\n${others}${candidates.length > 4 ? `\n  ... and ${candidates.length - 4} more (use name@file to filter)` : ''}`,
    } as { id: number; node: GraphNode };
  }

  if (results.nodes.length === 0) return err(`no symbol named "${searchName}"`);
  const options = results.nodes.slice(0, 10).map(n => `  ${n.name} (id=${n.id}) — ${rel(n.filePath, ws)}:${n.line}`).join('\n');
  return err(`no exact match for "${searchName}". Did you mean:\n${options}`);
}

function isToolResult(v: unknown): v is ToolResult {
  return typeof v === 'object' && v !== null && 'content' in v;
}

// ── Viewer control ─────────────────────────────────────────────────────────

function handleHighlight({ db, ws }: Ctx, args: Args): ToolResult {
  const rawIds = args.node_ids as number[] | undefined;
  const rawNames = args.node_names as string[] | undefined;

  if (!rawIds && !rawNames) return err('provide node_ids or node_names');

  // Resolve names to IDs
  const nodeIds: number[] = rawIds ? [...rawIds] : [];
  if (rawNames) {
    for (const name of rawNames) {
      const resolved = resolveNameToId(db, name, ws);
      if (isToolResult(resolved)) return resolved;
      nodeIds.push(resolved.id);
    }
  }

  writeViewerCommand(ws, {
    action: 'highlight',
    payload: { nodeIds },
    timestamp: Date.now(),
  });

  if (nodeIds.length === 0) {
    return text('Highlight cleared in IVE viewer.\n(Panel must be open to see the effect.)');
  }

  const labels = nodeIds.map(id => {
    const n = db.getSymbolById(id);
    return n ? `${n.name} (id=${id})` : `id=${id}`;
  });
  return text(`Highlighted ${nodeIds.length} node(s) in IVE viewer:\n${labels.map(l => `  ${l}`).join('\n')}\n\n(Panel must be open to see the effect.)`);
}

function handleSelectPath({ db, ws }: Ctx, args: Args): ToolResult {
  let fromId = args.from_id as number | undefined;
  let toId = args.to_id as number | undefined;
  const fromName = args.from_name as string | undefined;
  const toName = args.to_name as string | undefined;

  // Resolve names to IDs
  if (!fromId && fromName) {
    const resolved = resolveNameToId(db, fromName, ws);
    if (isToolResult(resolved)) return resolved;
    fromId = resolved.id;
  }
  if (!toId && toName) {
    const resolved = resolveNameToId(db, toName, ws);
    if (isToolResult(resolved)) return resolved;
    toId = resolved.id;
  }

  if (fromId == null || toId == null) return err('provide from_id/to_id or from_name/to_name');

  const fromNode = db.getSymbolById(fromId);
  const toNode = db.getSymbolById(toId);
  if (!fromNode) return err(`symbol ${fromId} not found`);
  if (!toNode) return err(`symbol ${toId} not found`);

  const edges = db.getAllEdges();
  const pathIds = findCallPath(edges, fromId, toId);

  if (!pathIds) {
    // Try undirected — if found, highlight that instead
    const undirected = findCallPathUndirected(edges, fromId, toId);
    if (undirected) {
      writeViewerCommand(ws, {
        action: 'highlight',
        payload: { nodeIds: undirected.path },
        timestamp: Date.now(),
      });
    }
    return text(diagnoseNoPath(db, edges, fromId, toId, fromNode, toNode, ws)
      + (undirected ? '\n\n(Undirected connection highlighted in viewer.)' : '')
      + '\n(Panel must be open to see the effect.)');
  }

  writeViewerCommand(ws, {
    action: 'highlight',
    payload: { nodeIds: pathIds },
    timestamp: Date.now(),
  });

  return text(`Call path (${pathIds.length} steps) — highlighted in IVE viewer:\n\n${fmtPath(db, pathIds, ws)}\n\n(Panel must be open to see the effect.)`);
}

// ── Exploration tools ──────────────────────────────────────────────────────

function handleGetNeighborhood({ db, ws }: Ctx, args: Args): ToolResult {
  let id = args.id as number | undefined;
  const name = args.name as string | undefined;
  const depth = (args.depth as number) ?? 2;

  if (!id && name) {
    const resolved = resolveNameToId(db, name, ws);
    if (isToolResult(resolved)) return resolved;
    id = resolved.id;
  }
  if (id == null) return err('provide id or name');

  const rootNode = db.getSymbolById(id);
  if (!rootNode) return err(`symbol ${id} not found`);

  const edges = db.getAllEdges();
  const neighborIds = getNeighborhood(edges, id, depth);

  // Build node list with metrics
  const metrics = db.getStructuralMetrics();
  const nodes: Array<{ node: GraphNode; coupling: number; relation: string }> = [];
  for (const nid of neighborIds) {
    const n = db.getSymbolById(nid);
    if (!n) continue;
    const c = metrics.get(nid)?.coupling ?? 0;
    const relation = nid === id ? 'ROOT' : '';
    nodes.push({ node: n, coupling: c, relation });
  }
  nodes.sort((a, b) => b.coupling - a.coupling);

  // Highlight in viewer
  writeViewerCommand(ws, {
    action: 'highlight',
    payload: { nodeIds: [...neighborIds] },
    timestamp: Date.now(),
  });

  let out = `Neighborhood of ${rootNode.name} (id=${id}) within ${depth} hops — ${neighborIds.size} nodes:\n\n`;
  for (const { node: n, coupling: c, relation } of nodes) {
    const marker = relation ? ` [${relation}]` : '';
    out += `  ${n.name} (id=${n.id}, coupling=${c}) — ${rel(n.filePath, ws)}:${n.line}${marker}\n`;
  }
  out += `\n(Highlighted in viewer. Panel must be open to see the effect.)`;
  return text(out);
}

function handleSuggestHighlights({ db, ws }: Ctx): ToolResult {
  const edges = db.getAllEdges();
  const metrics = db.getStructuralMetrics();
  const coverage = db.getProjectCoverage();
  const annotations = db.getAnnotations();
  const annotatedIds = new Set(annotations.filter(a => a.symbolId != null).map(a => a.symbolId));

  const suggestions: Array<{ title: string; why: string; nodeIds: number[]; score: number }> = [];

  // 1. Highest-coupling cluster: top coupling node + its neighborhood
  const byCoupling = [...metrics.values()].sort((a, b) => b.coupling - a.coupling);
  if (byCoupling.length > 0) {
    const top = byCoupling[0];
    const topNode = db.getSymbolById(top.id);
    const hood = getNeighborhood(edges, top.id, 1);
    if (topNode) {
      suggestions.push({
        title: `Highest coupling hub: ${topNode.name}`,
        why: `coupling=${top.coupling} (fanIn=${top.fanIn} × fanOut=${top.fanOut}), impact=${top.impactRadius}. ${hood.size} nodes within 1 hop.`,
        nodeIds: [...hood],
        score: top.coupling,
      });
    }
  }

  // 2. Deepest call chain
  const chains = findDeepestChains(edges, coverage.entryPointIds, 1);
  if (chains.length > 0 && chains[0].length >= 3) {
    const chain = chains[0];
    const entryNode = db.getSymbolById(chain[0]);
    const leafNode = db.getSymbolById(chain[chain.length - 1]);
    suggestions.push({
      title: `Deepest call chain: ${entryNode?.name ?? '?'} → ${leafNode?.name ?? '?'}`,
      why: `${chain.length} steps deep from entry point to leaf. Longest execution path in the codebase.`,
      nodeIds: chain,
      score: chain.length * 10,
    });
  }

  // 3. Highest-risk unannotated node + neighborhood
  const unannotatedRisks = [...metrics.values()]
    .filter(m => !annotatedIds.has(m.id) && (m.coupling >= 10 || m.impactRadius >= 20))
    .sort((a, b) => b.coupling - a.coupling);
  if (unannotatedRisks.length > 0) {
    const risk = unannotatedRisks[0];
    const riskNode = db.getSymbolById(risk.id);
    const hood = getNeighborhood(edges, risk.id, 1);
    if (riskNode) {
      suggestions.push({
        title: `Top unannotated risk: ${riskNode.name}`,
        why: `coupling=${risk.coupling}, impact=${risk.impactRadius}, no annotations. ${unannotatedRisks.length} unannotated risky functions total.`,
        nodeIds: [...hood],
        score: risk.coupling + risk.impactRadius,
      });
    }
  }

  // 4. Widest fan-out node
  const byFanOut = [...metrics.values()].sort((a, b) => b.fanOut - a.fanOut);
  if (byFanOut.length > 0 && byFanOut[0].fanOut >= 3) {
    const wide = byFanOut[0];
    // Skip if already covered by coupling suggestion
    if (!suggestions.some(s => s.nodeIds.includes(wide.id) && s.title.includes('coupling'))) {
      const wideNode = db.getSymbolById(wide.id);
      const hood = getNeighborhood(edges, wide.id, 1);
      if (wideNode) {
        suggestions.push({
          title: `Widest fan-out: ${wideNode.name}`,
          why: `Calls ${wide.fanOut} functions directly. Orchestrator or god-function candidate.`,
          nodeIds: [...hood],
          score: wide.fanOut * 5,
        });
      }
    }
  }

  // 5. Dead code cluster (if any)
  if (coverage.deadCodeIds.length > 0) {
    const deadSlice = coverage.deadCodeIds.slice(0, 10);
    const deadNames = deadSlice.map(id => db.getSymbolById(id)?.name ?? '?').slice(0, 5);
    suggestions.push({
      title: `Dead code cluster (${coverage.deadCodeIds.length} unreachable)`,
      why: `${deadNames.join(', ')}${coverage.deadCodeIds.length > 5 ? '...' : ''}. Candidates for removal.`,
      nodeIds: deadSlice,
      score: coverage.deadCodeIds.length,
    });
  }

  suggestions.sort((a, b) => b.score - a.score);
  const top = suggestions.slice(0, 5);

  let out = `=== Suggested Highlights (${top.length}) ===\n`;
  for (let i = 0; i < top.length; i++) {
    const s = top[i];
    out += `\n${i + 1}. ${s.title}\n`;
    out += `   Why: ${s.why}\n`;
    out += `   Nodes: [${s.nodeIds.slice(0, 8).join(', ')}${s.nodeIds.length > 8 ? '...' : ''}] (${s.nodeIds.length} total)\n`;
    out += `   → Use ive_highlight { node_ids: [${s.nodeIds.slice(0, 8).join(', ')}${s.nodeIds.length > 8 ? '...' : ''}] } to visualize\n`;
  }

  return text(out);
}

function handleHighlightCluster({ db, ws }: Ctx, args: Args): ToolResult {
  let id = args.id as number | undefined;
  const name = args.name as string | undefined;
  const strategy = (args.strategy as string) ?? 'neighborhood';

  if (!id && name) {
    const resolved = resolveNameToId(db, name, ws);
    if (isToolResult(resolved)) return resolved;
    id = resolved.id;
  }
  if (id == null) return err('provide id or name');

  const rootNode = db.getSymbolById(id);
  if (!rootNode) return err(`symbol ${id} not found`);

  const edges = db.getAllEdges();
  const metrics = db.getStructuralMetrics();
  let nodeIds: number[];
  let description: string;

  switch (strategy) {
    case 'high_coupling': {
      // Get neighborhood, then filter to only high-coupling nodes
      const hood = getNeighborhood(edges, id, 2);
      const threshold = 5;
      nodeIds = [...hood].filter(nid => (metrics.get(nid)?.coupling ?? 0) >= threshold || nid === id);
      description = `High-coupling cluster around ${rootNode.name}: ${nodeIds.length} nodes with coupling >= ${threshold} within 2 hops`;
      break;
    }
    case 'deep_chain': {
      // Find the longest forward chain from this node
      const forward = new Map<number, number[]>();
      for (const { sourceId, targetId } of edges) {
        if (!forward.has(sourceId)) forward.set(sourceId, []);
        forward.get(sourceId)!.push(targetId);
      }
      // DFS for longest path
      let longestPath = [id];
      const stack: Array<{ nodeId: number; path: number[] }> = [{ nodeId: id, path: [id] }];
      while (stack.length > 0) {
        const { nodeId, path: currentPath } = stack.pop()!;
        const neighbors = forward.get(nodeId) ?? [];
        let isLeaf = true;
        for (const n of neighbors) {
          if (currentPath.includes(n)) continue;
          isLeaf = false;
          stack.push({ nodeId: n, path: [...currentPath, n] });
        }
        if (isLeaf && currentPath.length > longestPath.length) {
          longestPath = currentPath;
        }
      }
      nodeIds = longestPath;
      const leafNode = db.getSymbolById(nodeIds[nodeIds.length - 1]);
      description = `Deepest chain from ${rootNode.name} → ${leafNode?.name ?? '?'}: ${nodeIds.length} steps`;
      break;
    }
    case 'neighborhood':
    default: {
      const hood = getNeighborhood(edges, id, 2);
      nodeIds = [...hood];
      description = `2-hop neighborhood of ${rootNode.name}: ${nodeIds.length} nodes`;
      break;
    }
  }

  writeViewerCommand(ws, {
    action: 'highlight',
    payload: { nodeIds },
    timestamp: Date.now(),
  });

  // List nodes with metrics
  const nodes = nodeIds.map(nid => {
    const n = db.getSymbolById(nid);
    const c = metrics.get(nid)?.coupling ?? 0;
    return n ? `  ${n.name} (id=${nid}, coupling=${c}) — ${rel(n.filePath, ws)}:${n.line}${nid === id ? ' [ROOT]' : ''}` : `  id=${nid}`;
  });

  return text(`${description}\n\n${nodes.join('\n')}\n\n(Highlighted in viewer. Panel must be open to see the effect.)`);
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
  ive_find_path: handleFindPath,
  ive_highlight: handleHighlight,
  ive_select_path: handleSelectPath,
  ive_get_neighborhood: handleGetNeighborhood,
  ive_suggest_highlights: handleSuggestHighlights,
  ive_highlight_cluster: handleHighlightCluster,
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
