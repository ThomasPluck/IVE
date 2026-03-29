import { describe, it, expect } from 'vitest';
import { detectCycles } from '../indexer/cycleDetector.js';

type Edge = { sourceId: number; targetId: number };

describe('detectCycles', () => {
  it('returns empty set for no edges', () => {
    expect(detectCycles([])).toEqual(new Set());
  });

  it('returns empty set for single directed edge (no cycle)', () => {
    const edges: Edge[] = [{ sourceId: 1, targetId: 2 }];
    expect(detectCycles(edges)).toEqual(new Set());
  });

  it('detects self-loop', () => {
    const edges: Edge[] = [{ sourceId: 1, targetId: 1 }];
    expect(detectCycles(edges)).toEqual(new Set([1]));
  });

  it('detects two-node cycle A→B→A', () => {
    const edges: Edge[] = [
      { sourceId: 1, targetId: 2 },
      { sourceId: 2, targetId: 1 },
    ];
    expect(detectCycles(edges)).toEqual(new Set([1, 2]));
  });

  it('detects triangle A→B→C→A', () => {
    const edges: Edge[] = [
      { sourceId: 1, targetId: 2 },
      { sourceId: 2, targetId: 3 },
      { sourceId: 3, targetId: 1 },
    ];
    expect(detectCycles(edges)).toEqual(new Set([1, 2, 3]));
  });

  it('returns empty set for a DAG (A→B, A→C, B→D)', () => {
    const edges: Edge[] = [
      { sourceId: 1, targetId: 2 },
      { sourceId: 1, targetId: 3 },
      { sourceId: 2, targetId: 4 },
    ];
    expect(detectCycles(edges)).toEqual(new Set());
  });

  it('detects two disconnected cycles', () => {
    const edges: Edge[] = [
      // Cycle 1: 1↔2
      { sourceId: 1, targetId: 2 },
      { sourceId: 2, targetId: 1 },
      // Cycle 2: 3↔4
      { sourceId: 3, targetId: 4 },
      { sourceId: 4, targetId: 3 },
    ];
    expect(detectCycles(edges)).toEqual(new Set([1, 2, 3, 4]));
  });

  it('marks shared node correctly when it participates in multiple cycles', () => {
    // A→B→A and B→C→B: node B is shared
    const edges: Edge[] = [
      { sourceId: 1, targetId: 2 },
      { sourceId: 2, targetId: 1 },
      { sourceId: 2, targetId: 3 },
      { sourceId: 3, targetId: 2 },
    ];
    const result = detectCycles(edges);
    expect(result.has(1)).toBe(true);
    expect(result.has(2)).toBe(true);
    expect(result.has(3)).toBe(true);
  });

  it('returns empty set for long chain without cycle (50 nodes)', () => {
    const edges: Edge[] = [];
    for (let i = 1; i < 50; i++) {
      edges.push({ sourceId: i, targetId: i + 1 });
    }
    expect(detectCycles(edges)).toEqual(new Set());
  });

  it('marks all nodes in a long cycle (50 nodes)', () => {
    const edges: Edge[] = [];
    for (let i = 1; i <= 50; i++) {
      edges.push({ sourceId: i, targetId: (i % 50) + 1 });
    }
    const result = detectCycles(edges);
    expect(result.size).toBe(50);
    for (let i = 1; i <= 50; i++) {
      expect(result.has(i)).toBe(true);
    }
  });
});
