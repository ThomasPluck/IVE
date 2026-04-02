import { describe, it, expect } from 'vitest';
import { extractRawCallEdges, resolveEdges } from '../parser/callGraphExtractor.js';
import { node, ident, mockTree } from './helpers/mockNode.js';
import type { SymbolRow } from '../indexer/database.js';

function sym(id: number, name: string, fileId = 1): SymbolRow {
  return { id, name, kind: 'function', fileId, startLine: 1, endLine: 21, loc: 21, parentSymbolId: null };
}

/** Build a call_expression node for a simple identifier call: foo() */
function simpleCall(calleeName: string) {
  return node('call_expression', {
    start: 2, end: 2,
    fields: { function: ident(calleeName) },
    children: [ident(calleeName)],
  });
}

/** Build a call_expression for a member call: obj.bar() */
function memberCall(propName: string) {
  const memberExpr = node('member_expression', {
    start: 2, end: 2,
    fields: { property: ident(propName) },
    children: [ident('obj'), ident(propName)],
  });
  return node('call_expression', {
    start: 2, end: 2,
    fields: { function: memberExpr },
    children: [memberExpr],
  });
}

/** Minimal DB stub */
function dbStub(lookupResult: Array<{ id: number; fileId: number }>) {
  return { lookupSymbolsByName: () => lookupResult } as any;
}

describe('extractRawCallEdges', () => {
  it('extracts a simple identifier call', () => {
    const callNode = simpleCall('foo');
    const tree = mockTree('main', [callNode], { start: 0, end: 20 });
    const edges = extractRawCallEdges(tree as any, 'typescript', [sym(1, 'main')]);
    expect(edges).toHaveLength(1);
    expect(edges[0].calleeName).toBe('foo');
    expect(edges[0].sourceSymbolId).toBe(1);
  });

  it('extracts member expression call (obj.bar())', () => {
    const callNode = memberCall('bar');
    const tree = mockTree('main', [callNode], { start: 0, end: 20 });
    const edges = extractRawCallEdges(tree as any, 'typescript', [sym(1, 'main')]);
    expect(edges).toHaveLength(1);
    expect(edges[0].calleeName).toBe('bar');
  });

  it('filters out self-calls', () => {
    const callNode = simpleCall('main');
    const tree = mockTree('main', [callNode], { start: 0, end: 20 });
    const edges = extractRawCallEdges(tree as any, 'typescript', [sym(1, 'main')]);
    expect(edges).toHaveLength(0);
  });

  it('returns empty for non-callable symbol kinds', () => {
    const callNode = simpleCall('foo');
    const tree = mockTree('main', [callNode], { start: 0, end: 20 });
    const classSym: SymbolRow = { id: 1, name: 'MyClass', kind: 'class', fileId: 1, startLine: 1, endLine: 21, loc: 21, parentSymbolId: null };
    const edges = extractRawCallEdges(tree as any, 'typescript', [classSym]);
    expect(edges).toHaveLength(0);
  });

  it('returns empty for empty symbols list', () => {
    const tree = mockTree('main', [simpleCall('foo')], { start: 0, end: 20 });
    const edges = extractRawCallEdges(tree as any, 'typescript', []);
    expect(edges).toHaveLength(0);
  });

  it('returns empty for unsupported language', () => {
    const tree = mockTree('main', [simpleCall('foo')], { start: 0, end: 20 });
    const edges = extractRawCallEdges(tree as any, 'cobol', [sym(1, 'main')]);
    expect(edges).toHaveLength(0);
  });

  it('extracts both calls from nested call foo(bar())', () => {
    const innerCall = simpleCall('bar');
    // Outer call_expression wrapping inner as a child
    const outerCall = node('call_expression', {
      start: 2, end: 2,
      fields: { function: ident('foo') },
      children: [ident('foo'), innerCall],
    });
    const tree = mockTree('main', [outerCall], { start: 0, end: 20 });
    const edges = extractRawCallEdges(tree as any, 'typescript', [sym(1, 'main')]);
    const names = edges.map(e => e.calleeName);
    expect(names).toContain('foo');
    expect(names).toContain('bar');
    expect(edges).toHaveLength(2);
  });
});

describe('resolveEdges', () => {
  it('returns empty when callee not found in DB', () => {
    const rawEdges = [{ sourceSymbolId: 1, calleeName: 'unknownFn', sourceFileId: 1 }];
    const result = resolveEdges(rawEdges, dbStub([]));
    expect(result).toHaveLength(0);
  });

  it('prefers same-file match over cross-file match', () => {
    const rawEdges = [{ sourceSymbolId: 1, calleeName: 'parse', sourceFileId: 10 }];
    const candidates = [
      { id: 100, fileId: 99 }, // cross-file
      { id: 200, fileId: 10 }, // same-file ← should be chosen
    ];
    const result = resolveEdges(rawEdges, dbStub(candidates));
    expect(result).toHaveLength(1);
    expect(result[0].targetId).toBe(200);
    expect(result[0].kind).toBe('call');
  });

  it('falls back to first candidate when no same-file match', () => {
    const rawEdges = [{ sourceSymbolId: 1, calleeName: 'helper', sourceFileId: 10 }];
    const candidates = [{ id: 50, fileId: 99 }];
    const result = resolveEdges(rawEdges, dbStub(candidates));
    expect(result).toHaveLength(1);
    expect(result[0].targetId).toBe(50);
  });

  it('deduplicates multiple raw edges to the same (source, target) pair', () => {
    const rawEdges = [
      { sourceSymbolId: 1, calleeName: 'foo', sourceFileId: 1 },
      { sourceSymbolId: 1, calleeName: 'foo', sourceFileId: 1 }, // duplicate
    ];
    const candidates = [{ id: 42, fileId: 1 }];
    const result = resolveEdges(rawEdges, dbStub(candidates));
    expect(result).toHaveLength(1);
  });

  it('returns empty for empty rawEdges', () => {
    const result = resolveEdges([], dbStub([]));
    expect(result).toHaveLength(0);
  });

  it('resolves cross-file call correctly', () => {
    const rawEdges = [{ sourceSymbolId: 5, calleeName: 'utilFn', sourceFileId: 2 }];
    const candidates = [{ id: 77, fileId: 3 }]; // different file
    const result = resolveEdges(rawEdges, dbStub(candidates));
    expect(result).toHaveLength(1);
    expect(result[0].sourceId).toBe(5);
    expect(result[0].targetId).toBe(77);
  });

  it('resolves aliased import via importsByFile fallback', () => {
    // myTool is an alias for setTool — name lookup returns nothing for myTool,
    // but the import map tells us to retry with setTool
    let callCount = 0;
    const db = {
      lookupSymbolsByName(name: string) {
        callCount++;
        if (name === 'myTool') return []; // alias not found
        if (name === 'setTool') return [{ id: 99, fileId: 2, kind: 'function' }];
        return [];
      },
    } as any;

    const rawEdges = [{
      sourceSymbolId: 1,
      calleeName: 'myTool',
      sourceFileId: 1,
      callLine: 5,
      callText: 'myTool()',
      isMemberCall: false,
    }];

    const importsByFile = new Map([
      [1, [{ localName: 'myTool', importedName: 'setTool', sourceModule: 'instant-state' }]],
    ]);

    const result = resolveEdges(rawEdges, db, undefined, importsByFile);
    expect(result).toHaveLength(1);
    expect(result[0].targetId).toBe(99);
    expect(callCount).toBe(2); // tried myTool, then setTool
  });
});
