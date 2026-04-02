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

/**
 * Find the shortest call path from `fromId` to `toId` using BFS.
 * Returns the ordered path [fromId, ..., toId] or null if unreachable.
 */
export function findCallPath(edges: Edge[], fromId: number, toId: number): number[] | null {
  if (fromId === toId) return [fromId];

  const adj = buildAdjacency(edges);
  const parent = new Map<number, number>();
  const visited = new Set<number>([fromId]);
  const queue = [fromId];

  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const neighbor of adj.get(node) ?? []) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      parent.set(neighbor, node);
      if (neighbor === toId) {
        // Reconstruct path
        const path = [toId];
        let cur = toId;
        while (cur !== fromId) {
          cur = parent.get(cur)!;
          path.unshift(cur);
        }
        return path;
      }
      queue.push(neighbor);
    }
  }

  return null;
}

/**
 * Find shortest path treating edges as undirected (either direction).
 * Returns ordered path or null. Direction labels indicate edge orientation.
 */
export function findCallPathUndirected(
  edges: Edge[],
  fromId: number,
  toId: number
): { path: number[]; directions: Array<'forward' | 'backward'> } | null {
  if (fromId === toId) return { path: [fromId], directions: [] };

  const forward = buildAdjacency(edges);
  const reverse = buildReverseAdjacency(edges);

  const parent = new Map<number, { from: number; dir: 'forward' | 'backward' }>();
  const visited = new Set<number>([fromId]);
  const queue = [fromId];

  while (queue.length > 0) {
    const node = queue.shift()!;

    const neighbors: Array<{ id: number; dir: 'forward' | 'backward' }> = [];
    for (const n of forward.get(node) ?? []) neighbors.push({ id: n, dir: 'forward' });
    for (const n of reverse.get(node) ?? []) neighbors.push({ id: n, dir: 'backward' });

    for (const { id: neighbor, dir } of neighbors) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      parent.set(neighbor, { from: node, dir });
      if (neighbor === toId) {
        const path = [toId];
        const directions: Array<'forward' | 'backward'> = [];
        let cur = toId;
        while (cur !== fromId) {
          const p = parent.get(cur)!;
          directions.unshift(p.dir);
          cur = p.from;
          path.unshift(cur);
        }
        return { path, directions };
      }
      queue.push(neighbor);
    }
  }

  return null;
}

/**
 * Get the N-hop neighborhood around a node (both directions).
 * Returns the set of node IDs within `depth` hops.
 */
export function getNeighborhood(edges: Edge[], rootId: number, depth: number): Set<number> {
  const forward = buildAdjacency(edges);
  const reverse = buildReverseAdjacency(edges);
  const visited = new Set<number>([rootId]);
  let frontier = [rootId];

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: number[] = [];
    for (const node of frontier) {
      for (const n of forward.get(node) ?? []) {
        if (!visited.has(n)) { visited.add(n); next.push(n); }
      }
      for (const n of reverse.get(node) ?? []) {
        if (!visited.has(n)) { visited.add(n); next.push(n); }
      }
    }
    frontier = next;
  }

  return visited;
}

/**
 * Find which connected component a node belongs to (undirected).
 * Returns the set of all node IDs in the same component.
 */
export function getConnectedComponent(edges: Edge[], nodeId: number): Set<number> {
  return getNeighborhood(edges, nodeId, Infinity);
}

/**
 * Find the deepest call chains from entry points.
 * Returns the top N chains as arrays of node IDs (from entry to leaf).
 */
export function findDeepestChains(
  edges: Edge[],
  entryPointIds: number[],
  topN: number = 5
): number[][] {
  const forward = buildAdjacency(edges);
  const chains: number[][] = [];

  for (const entry of entryPointIds) {
    // DFS to find longest paths from this entry
    const stack: Array<{ id: number; path: number[] }> = [{ id: entry, path: [entry] }];
    const bestPathTo = new Map<number, number>(); // node → longest path length reaching it

    while (stack.length > 0) {
      const { id, path } = stack.pop()!;

      // Skip if we've already found a longer path to this node
      if ((bestPathTo.get(id) ?? 0) >= path.length && path.length > 1) continue;
      bestPathTo.set(id, path.length);

      const neighbors = forward.get(id) ?? [];
      let isLeaf = true;

      for (const n of neighbors) {
        if (path.includes(n)) continue; // avoid cycles
        isLeaf = false;
        stack.push({ id: n, path: [...path, n] });
      }

      if (isLeaf && path.length >= 2) {
        chains.push(path);
      }
    }
  }

  // Sort by length descending, return top N
  chains.sort((a, b) => b.length - a.length);
  return chains.slice(0, topN);
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
