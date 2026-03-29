/**
 * Structural analysis of the call graph.
 * Pure functions — no DB, no VSCode, fully testable.
 */

export interface ProjectCoverage {
  totalFunctions: number;
  reachableCount: number;
  deadCodeIds: number[];
  entryPointIds: number[];
  coveragePercent: number;
}

export interface SymbolStructure {
  id: number;
  fanIn: number;
  fanOut: number;
  coupling: number;         // fanIn * fanOut
  depthFromEntry: number;   // shortest BFS distance from any entry point (-1 = unreachable)
  impactRadius: number;     // count of transitively downstream functions
  module: string;           // directory-level module derived from file path
  isDeadCode: boolean;
}

export interface ModuleBoundary {
  sourceModule: string;
  targetModule: string;
  edgeCount: number;
}

interface Edge {
  sourceId: number;
  targetId: number;
}

/**
 * Multi-source BFS from entry points. Returns coverage stats + dead code IDs.
 */
export function computeReachability(
  edges: Edge[],
  allFunctionIds: number[],
  entryPointIds: number[]
): ProjectCoverage {
  const total = allFunctionIds.length;
  if (total === 0) {
    return { totalFunctions: 0, reachableCount: 0, deadCodeIds: [], entryPointIds, coveragePercent: 100 };
  }

  const forward = buildAdjacency(edges);
  const reachable = bfsForward(forward, entryPointIds);
  const allSet = new Set(allFunctionIds);
  const deadCodeIds = allFunctionIds.filter(id => !reachable.has(id));

  return {
    totalFunctions: total,
    reachableCount: reachable.size,
    deadCodeIds,
    entryPointIds,
    coveragePercent: Math.round((reachable.size / total) * 100),
  };
}

/**
 * Compute all structural metrics for every function in a single pass.
 * filePathMap: symbolId → filePath (used for module derivation).
 * workspacePath: workspace root for computing relative module paths.
 */
export function computeStructuralMetrics(
  edges: Edge[],
  allFunctionIds: number[],
  entryPointIds: number[],
  filePathMap: Map<number, string>,
  workspacePath: string
): Map<number, SymbolStructure> {
  const forward = buildAdjacency(edges);
  const reverse = buildReverseAdjacency(edges);

  // Fan-in / fan-out
  const fanInMap = new Map<number, number>();
  const fanOutMap = new Map<number, number>();
  for (const id of allFunctionIds) {
    fanInMap.set(id, 0);
    fanOutMap.set(id, 0);
  }
  for (const { sourceId, targetId } of edges) {
    if (fanOutMap.has(sourceId)) fanOutMap.set(sourceId, (fanOutMap.get(sourceId) ?? 0) + 1);
    if (fanInMap.has(targetId)) fanInMap.set(targetId, (fanInMap.get(targetId) ?? 0) + 1);
  }

  // Depth from entry points (multi-source BFS)
  const depthMap = bfsDepth(forward, entryPointIds);

  // Reachable set for dead code
  const reachable = new Set(depthMap.keys());

  // Impact radius per node (BFS forward from each node)
  const impactMap = computeImpactRadius(forward, allFunctionIds);

  // Build results
  const result = new Map<number, SymbolStructure>();
  for (const id of allFunctionIds) {
    const fanIn = fanInMap.get(id) ?? 0;
    const fanOut = fanOutMap.get(id) ?? 0;
    const depth = depthMap.get(id) ?? -1;
    const filePath = filePathMap.get(id) ?? '';
    const mod = deriveModule(filePath, workspacePath);

    result.set(id, {
      id,
      fanIn,
      fanOut,
      coupling: fanIn * fanOut,
      depthFromEntry: depth,
      impactRadius: impactMap.get(id) ?? 0,
      module: mod,
      isDeadCode: !reachable.has(id),
    });
  }

  return result;
}

/**
 * Group cross-module edges and count them.
 */
export function detectModuleBoundaries(
  edges: Edge[],
  moduleMap: Map<number, string>
): ModuleBoundary[] {
  const counts = new Map<string, number>();

  for (const { sourceId, targetId } of edges) {
    const srcMod = moduleMap.get(sourceId);
    const tgtMod = moduleMap.get(targetId);
    if (!srcMod || !tgtMod || srcMod === tgtMod) continue;

    const key = `${srcMod}→${tgtMod}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const boundaries: ModuleBoundary[] = [];
  for (const [key, count] of counts) {
    const [sourceModule, targetModule] = key.split('→');
    boundaries.push({ sourceModule, targetModule, edgeCount: count });
  }

  return boundaries.sort((a, b) => b.edgeCount - a.edgeCount);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function buildAdjacency(edges: Edge[]): Map<number, number[]> {
  const adj = new Map<number, number[]>();
  for (const { sourceId, targetId } of edges) {
    if (!adj.has(sourceId)) adj.set(sourceId, []);
    adj.get(sourceId)!.push(targetId);
  }
  return adj;
}

function buildReverseAdjacency(edges: Edge[]): Map<number, number[]> {
  const adj = new Map<number, number[]>();
  for (const { sourceId, targetId } of edges) {
    if (!adj.has(targetId)) adj.set(targetId, []);
    adj.get(targetId)!.push(sourceId);
  }
  return adj;
}

/** BFS forward from sources, returns all visited node IDs. */
function bfsForward(adj: Map<number, number[]>, sources: number[]): Set<number> {
  const visited = new Set<number>();
  const queue = [...sources];
  for (const s of sources) visited.add(s);

  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const neighbor of adj.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return visited;
}

/** Multi-source BFS returning distance map. */
function bfsDepth(adj: Map<number, number[]>, sources: number[]): Map<number, number> {
  const depth = new Map<number, number>();
  const queue: Array<{ id: number; d: number }> = [];

  for (const s of sources) {
    depth.set(s, 0);
    queue.push({ id: s, d: 0 });
  }

  while (queue.length > 0) {
    const { id, d } = queue.shift()!;
    for (const neighbor of adj.get(id) ?? []) {
      if (!depth.has(neighbor)) {
        depth.set(neighbor, d + 1);
        queue.push({ id: neighbor, d: d + 1 });
      }
    }
  }

  return depth;
}

/**
 * For each function, count how many other functions are transitively reachable
 * via forward edges (its "blast radius" if changed).
 */
function computeImpactRadius(adj: Map<number, number[]>, allIds: number[]): Map<number, number> {
  const result = new Map<number, number>();

  for (const id of allIds) {
    const reachable = bfsForward(adj, [id]);
    // Subtract 1 to exclude the node itself
    result.set(id, reachable.size - 1);
  }

  return result;
}

/** Derive module name from file path relative to workspace. */
export function deriveModule(filePath: string, workspacePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const wsNormalized = workspacePath.replace(/\\/g, '/').replace(/\/$/, '');

  let relative = normalized;
  if (normalized.startsWith(wsNormalized)) {
    relative = normalized.slice(wsNormalized.length + 1);
  }

  // Module = first two path segments (e.g. "src/parser", "src/indexer", "webview/src")
  const parts = relative.split('/');
  if (parts.length >= 2) return parts.slice(0, 2).join('/');
  return parts[0] ?? 'root';
}
