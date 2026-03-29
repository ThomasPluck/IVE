export interface RawEdge {
  sourceId: number;
  targetId: number;
}

/**
 * Iterative DFS-based cycle detection.
 * Returns the set of node IDs that participate in at least one cycle.
 * Uses an explicit stack to avoid call-stack overflow on large graphs.
 */
export function detectCycles(edges: RawEdge[]): Set<number> {
  // Build adjacency list
  const adj = new Map<number, number[]>();
  for (const { sourceId, targetId } of edges) {
    if (!adj.has(sourceId)) adj.set(sourceId, []);
    adj.get(sourceId)!.push(targetId);
    // Ensure target is in the map even if it has no outgoing edges
    if (!adj.has(targetId)) adj.set(targetId, []);
  }

  const allNodes = [...adj.keys()];
  const visited = new Set<number>();
  const cycleNodes = new Set<number>();

  for (const start of allNodes) {
    if (visited.has(start)) continue;

    // Iterative DFS with an explicit stack
    // Each stack entry: [nodeId, iteratorIndex, pathSet]
    const stack: Array<{ id: number; childIdx: number }> = [];
    const inStack = new Set<number>();
    // path tracks the current DFS path for back-edge detection
    const path: number[] = [];

    stack.push({ id: start, childIdx: 0 });
    inStack.add(start);
    path.push(start);
    visited.add(start);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const children = adj.get(top.id) ?? [];

      if (top.childIdx >= children.length) {
        // Done with this node — pop it
        stack.pop();
        inStack.delete(top.id);
        path.pop();
        continue;
      }

      const child = children[top.childIdx];
      top.childIdx++;

      if (inStack.has(child)) {
        // Back edge found — everything from child to end of path is in a cycle
        const cycleStart = path.indexOf(child);
        if (cycleStart !== -1) {
          for (let i = cycleStart; i < path.length; i++) {
            cycleNodes.add(path[i]);
          }
          cycleNodes.add(child);
        }
        continue;
      }

      if (!visited.has(child)) {
        visited.add(child);
        stack.push({ id: child, childIdx: 0 });
        inStack.add(child);
        path.push(child);
      }
    }
  }

  return cycleNodes;
}
