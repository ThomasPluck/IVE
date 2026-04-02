import { describe, it, expect } from 'vitest';
import {
  computeReachability,
  computeStructuralMetrics,
  detectModuleBoundaries,
  deriveModule,
  findCallPath,
} from '../indexer/graphAnalyzer.js';

// ── computeReachability ──────────────────────────────────────────────────────

describe('computeReachability', () => {
  it('empty graph → 100% coverage, no dead code', () => {
    const r = computeReachability([], [], []);
    expect(r.totalFunctions).toBe(0);
    expect(r.coveragePercent).toBe(100);
    expect(r.deadCodeIds).toEqual([]);
  });

  it('single entry point with no edges → 100% (only the entry)', () => {
    const r = computeReachability([], [1], [1]);
    expect(r.totalFunctions).toBe(1);
    expect(r.reachableCount).toBe(1);
    expect(r.deadCodeIds).toEqual([]);
  });

  it('linear chain A→B→C, entry=A → all reachable', () => {
    const edges = [{ sourceId: 1, targetId: 2 }, { sourceId: 2, targetId: 3 }];
    const r = computeReachability(edges, [1, 2, 3], [1]);
    expect(r.reachableCount).toBe(3);
    expect(r.deadCodeIds).toEqual([]);
    expect(r.coveragePercent).toBe(100);
  });

  it('disconnected node D is dead code', () => {
    const edges = [{ sourceId: 1, targetId: 2 }];
    const r = computeReachability(edges, [1, 2, 3], [1]);
    expect(r.reachableCount).toBe(2);
    expect(r.deadCodeIds).toEqual([3]);
    expect(r.coveragePercent).toBe(67); // 2/3 rounded
  });

  it('multiple entry points cover different branches', () => {
    const edges = [
      { sourceId: 1, targetId: 3 },
      { sourceId: 2, targetId: 4 },
    ];
    const r = computeReachability(edges, [1, 2, 3, 4, 5], [1, 2]);
    expect(r.reachableCount).toBe(4); // 1,2,3,4 reachable; 5 is dead
    expect(r.deadCodeIds).toEqual([5]);
  });

  it('cycle does not prevent reachability', () => {
    const edges = [
      { sourceId: 1, targetId: 2 },
      { sourceId: 2, targetId: 3 },
      { sourceId: 3, targetId: 2 }, // cycle
    ];
    const r = computeReachability(edges, [1, 2, 3], [1]);
    expect(r.reachableCount).toBe(3);
  });

  it('large disconnected set → many dead', () => {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    const edges = [{ sourceId: 1, targetId: 2 }];
    const r = computeReachability(edges, ids, [1]);
    expect(r.reachableCount).toBe(2);
    expect(r.deadCodeIds).toHaveLength(98);
    expect(r.coveragePercent).toBe(2);
  });
});

// ── computeStructuralMetrics ─────────────────────────────────────────────────

describe('computeStructuralMetrics', () => {
  const ws = '/workspace';
  const pathMap = new Map<number, string>([
    [1, '/workspace/src/parser/foo.ts'],
    [2, '/workspace/src/parser/bar.ts'],
    [3, '/workspace/src/indexer/baz.ts'],
    [4, '/workspace/src/indexer/qux.ts'],
  ]);

  it('computes fan-in, fan-out, coupling for a simple graph', () => {
    const edges = [
      { sourceId: 1, targetId: 2 },
      { sourceId: 1, targetId: 3 },
      { sourceId: 2, targetId: 3 },
    ];
    const metrics = computeStructuralMetrics(edges, [1, 2, 3, 4], [1], pathMap, ws);

    const m1 = metrics.get(1)!;
    expect(m1.fanIn).toBe(0);  // no one calls 1
    expect(m1.fanOut).toBe(2); // calls 2 and 3
    expect(m1.coupling).toBe(0); // 0 * 2

    const m2 = metrics.get(2)!;
    expect(m2.fanIn).toBe(1);  // called by 1
    expect(m2.fanOut).toBe(1); // calls 3
    expect(m2.coupling).toBe(1); // 1 * 1

    const m3 = metrics.get(3)!;
    expect(m3.fanIn).toBe(2);  // called by 1 and 2
    expect(m3.fanOut).toBe(0);
    expect(m3.coupling).toBe(0); // 2 * 0
  });

  it('computes depth from entry points', () => {
    const edges = [
      { sourceId: 1, targetId: 2 },
      { sourceId: 2, targetId: 3 },
    ];
    const metrics = computeStructuralMetrics(edges, [1, 2, 3, 4], [1], pathMap, ws);

    expect(metrics.get(1)!.depthFromEntry).toBe(0);
    expect(metrics.get(2)!.depthFromEntry).toBe(1);
    expect(metrics.get(3)!.depthFromEntry).toBe(2);
    expect(metrics.get(4)!.depthFromEntry).toBe(-1); // unreachable
  });

  it('marks unreachable nodes as dead code', () => {
    const edges = [{ sourceId: 1, targetId: 2 }];
    const metrics = computeStructuralMetrics(edges, [1, 2, 3], [1], pathMap, ws);

    expect(metrics.get(1)!.isDeadCode).toBe(false);
    expect(metrics.get(2)!.isDeadCode).toBe(false);
    expect(metrics.get(3)!.isDeadCode).toBe(true);
  });

  it('computes impact radius correctly', () => {
    // 1→2→3, 1→4
    const edges = [
      { sourceId: 1, targetId: 2 },
      { sourceId: 2, targetId: 3 },
      { sourceId: 1, targetId: 4 },
    ];
    const metrics = computeStructuralMetrics(edges, [1, 2, 3, 4], [1], pathMap, ws);

    expect(metrics.get(1)!.impactRadius).toBe(3); // reaches 2, 3, 4
    expect(metrics.get(2)!.impactRadius).toBe(1); // reaches 3
    expect(metrics.get(3)!.impactRadius).toBe(0); // leaf
    expect(metrics.get(4)!.impactRadius).toBe(0); // leaf
  });

  it('derives module from file path', () => {
    const edges: Array<{ sourceId: number; targetId: number }> = [];
    const metrics = computeStructuralMetrics(edges, [1, 3], [1], pathMap, ws);

    expect(metrics.get(1)!.module).toBe('src/parser');
    expect(metrics.get(3)!.module).toBe('src/indexer');
  });
});

// ── detectModuleBoundaries ───────────────────────────────────────────────────

describe('detectModuleBoundaries', () => {
  it('returns empty for intra-module edges', () => {
    const moduleMap = new Map([[1, 'src/parser'], [2, 'src/parser']]);
    const result = detectModuleBoundaries([{ sourceId: 1, targetId: 2 }], moduleMap);
    expect(result).toHaveLength(0);
  });

  it('counts cross-module edges', () => {
    const moduleMap = new Map([[1, 'src/parser'], [2, 'src/indexer'], [3, 'src/indexer']]);
    const edges = [
      { sourceId: 1, targetId: 2 },
      { sourceId: 1, targetId: 3 },
    ];
    const result = detectModuleBoundaries(edges, moduleMap);
    expect(result).toHaveLength(1);
    expect(result[0].sourceModule).toBe('src/parser');
    expect(result[0].targetModule).toBe('src/indexer');
    expect(result[0].edgeCount).toBe(2);
  });

  it('sorts by edge count descending', () => {
    const moduleMap = new Map([
      [1, 'A'], [2, 'B'], [3, 'C'], [4, 'A'],
    ]);
    const edges = [
      { sourceId: 1, targetId: 2 },
      { sourceId: 1, targetId: 3 },
      { sourceId: 4, targetId: 3 },
      { sourceId: 4, targetId: 2 },
    ];
    const result = detectModuleBoundaries(edges, moduleMap);
    // A→B: 2 edges, A→C: 2 edges
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0].edgeCount).toBeGreaterThanOrEqual(result[1].edgeCount);
  });
});

// ── deriveModule ─────────────────────────────────────────────────────────────

describe('deriveModule', () => {
  it('extracts first two path segments relative to workspace', () => {
    expect(deriveModule('/ws/src/parser/foo.ts', '/ws')).toBe('src/parser');
    expect(deriveModule('/ws/src/indexer/bar.ts', '/ws')).toBe('src/indexer');
  });

  it('handles Windows-style backslashes', () => {
    expect(deriveModule('C:\\proj\\src\\ai\\client.ts', 'C:\\proj')).toBe('src/ai');
  });

  it('single segment → returns that segment', () => {
    expect(deriveModule('/ws/file.ts', '/ws')).toBe('file.ts');
  });

  it('root file with no workspace prefix → returns first two segments', () => {
    expect(deriveModule('src/parser/foo.ts', '/other')).toBe('src/parser');
  });
});

// ── findCallPath ────────────────────────────────────────────────────────────

describe('findCallPath', () => {
  const edges = [
    { sourceId: 1, targetId: 2 },
    { sourceId: 2, targetId: 3 },
    { sourceId: 3, targetId: 4 },
  ];

  it('finds direct path', () => {
    expect(findCallPath(edges, 1, 2)).toEqual([1, 2]);
  });

  it('finds multi-hop path', () => {
    expect(findCallPath(edges, 1, 4)).toEqual([1, 2, 3, 4]);
  });

  it('returns null for unreachable target', () => {
    expect(findCallPath(edges, 4, 1)).toBeNull();
  });

  it('returns single-element path for same node', () => {
    expect(findCallPath(edges, 2, 2)).toEqual([2]);
  });

  it('finds shortest path when multiple exist', () => {
    const edgesWithShortcut = [
      ...edges,
      { sourceId: 1, targetId: 4 }, // shortcut
    ];
    expect(findCallPath(edgesWithShortcut, 1, 4)).toEqual([1, 4]);
  });
});
