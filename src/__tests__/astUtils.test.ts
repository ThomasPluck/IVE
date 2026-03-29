import { describe, it, expect } from 'vitest';
import { findNodeAtRange } from '../parser/astUtils.js';
import { node } from './helpers/mockNode.js';

describe('findNodeAtRange', () => {
  it('returns null when node does not contain range (startRow too late)', () => {
    const n = node('program', { start: 5, end: 10 });
    expect(findNodeAtRange(n as any, 0, 10)).toBeNull();
  });

  it('returns null when node does not contain range (endRow too early)', () => {
    const n = node('program', { start: 0, end: 5 });
    expect(findNodeAtRange(n as any, 0, 10)).toBeNull();
  });

  it('returns the node itself when it has no children', () => {
    const n = node('function_declaration', { start: 0, end: 10 });
    expect(findNodeAtRange(n as any, 2, 8)).toBe(n);
  });

  it('returns the node when exact match on boundaries', () => {
    const n = node('function_declaration', { start: 3, end: 7 });
    expect(findNodeAtRange(n as any, 3, 7)).toBe(n);
  });

  it('returns deepest child that fully contains the range', () => {
    const grandchild = node('if_statement', { start: 4, end: 6 });
    const child = node('statement_block', { start: 2, end: 8, children: [grandchild] });
    const root = node('program', { start: 0, end: 10, children: [child] });

    const result = findNodeAtRange(root as any, 4, 6);
    expect(result).toBe(grandchild);
  });

  it('returns parent when no child fully contains the range', () => {
    // child covers 3-5, but query is 2-8 — child is too narrow
    const child = node('if_statement', { start: 3, end: 5 });
    const parent = node('function_declaration', { start: 0, end: 10, children: [child] });

    const result = findNodeAtRange(parent as any, 2, 8);
    expect(result).toBe(parent);
  });

  it('selects the correct child when multiple children exist', () => {
    const child1 = node('if_statement', { start: 1, end: 3 });
    const child2 = node('for_statement', { start: 5, end: 9 });
    const parent = node('function_declaration', { start: 0, end: 10, children: [child1, child2] });

    // Query range 5-9 should match child2, not child1
    const result = findNodeAtRange(parent as any, 5, 9);
    expect(result).toBe(child2);
  });
});
