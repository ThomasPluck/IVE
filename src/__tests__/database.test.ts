import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { IVEDatabase } from '../indexer/database.js';
import type { ExtractedSymbol } from '../parser/symbolExtractor.js';

// Point at sql.js WASM in node_modules (available after npm install)
const EXTENSION_PATH = path.resolve('node_modules/sql.js');

let tmpDir: string;
let db: IVEDatabase;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ive-test-'));
  db = new IVEDatabase(tmpDir, EXTENSION_PATH);
  await db.open();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── upsertFile ────────────────────────────────────────────────────────────────

describe('upsertFile', () => {
  it('new file returns a positive integer ID and changed=true', () => {
    const { id, changed } = db.upsertFile('/ws/foo.ts', 'typescript', 10, Date.now(), 'abc123');
    expect(id).toBeTypeOf('number');
    expect(id).toBeGreaterThan(0);
    expect(changed).toBe(true);
  });

  it('same path + same hash returns the same ID, changed=false, without deleting symbols', () => {
    const { id } = db.upsertFile('/ws/foo.ts', 'typescript', 10, Date.now(), 'abc');
    const sym: ExtractedSymbol = { name: 'fn1', kind: 'function', startLine: 1, endLine: 5, loc: 5, children: [] };
    db.insertSymbols(id, [sym]);

    const r2 = db.upsertFile('/ws/foo.ts', 'typescript', 10, Date.now(), 'abc');
    expect(r2.id).toBe(id);
    expect(r2.changed).toBe(false);
    expect(db.getSymbolsByFileId(id)).toHaveLength(1);
  });

  it('same path + different hash returns same ID, changed=true, and deletes old symbols', () => {
    const { id } = db.upsertFile('/ws/foo.ts', 'typescript', 10, Date.now(), 'hash-v1');
    const syms: ExtractedSymbol[] = [
      { name: 'fn1', kind: 'function', startLine: 1, endLine: 5, loc: 5, children: [] },
      { name: 'fn2', kind: 'function', startLine: 6, endLine: 10, loc: 5, children: [] },
    ];
    db.insertSymbols(id, syms);
    expect(db.getSymbolsByFileId(id)).toHaveLength(2);

    const r2 = db.upsertFile('/ws/foo.ts', 'typescript', 10, Date.now(), 'hash-v2');
    expect(r2.id).toBe(id);
    expect(r2.changed).toBe(true);
    expect(db.getSymbolsByFileId(id)).toHaveLength(0);
  });
});

// ── insertSymbols ─────────────────────────────────────────────────────────────

describe('insertSymbols', () => {
  it('flat list returns correct number of IDs', () => {
    const { id: fileId } = db.upsertFile('/ws/a.ts', 'typescript', 20, Date.now(), 'h1');
    const syms: ExtractedSymbol[] = [
      { name: 'a', kind: 'function', startLine: 1, endLine: 5, loc: 5, children: [] },
      { name: 'b', kind: 'function', startLine: 6, endLine: 10, loc: 5, children: [] },
      { name: 'c', kind: 'method',   startLine: 11, endLine: 15, loc: 5, children: [] },
    ];
    const ids = db.insertSymbols(fileId, syms);
    expect(ids).toHaveLength(3);
    expect(ids.every(id => id > 0)).toBe(true);
  });

  it('nested symbols have parent_symbol_id set', () => {
    const { id: fileId } = db.upsertFile('/ws/b.ts', 'typescript', 30, Date.now(), 'h2');
    const child: ExtractedSymbol = { name: 'method1', kind: 'method', startLine: 3, endLine: 5, loc: 3, children: [] };
    const parent: ExtractedSymbol = { name: 'MyClass', kind: 'class', startLine: 1, endLine: 10, loc: 10, children: [child] };
    db.insertSymbols(fileId, [parent]);

    const rows = db.getSymbolsByFileId(fileId);
    const parentRow = rows.find(r => r.name === 'MyClass');
    const childRow  = rows.find(r => r.name === 'method1');
    expect(parentRow).toBeDefined();
    expect(childRow).toBeDefined();
    expect(childRow!.parentSymbolId).toBe(parentRow!.id);
  });
});

// ── getGraphData ──────────────────────────────────────────────────────────────

describe('getGraphData', () => {
  it('empty database returns empty graph', () => {
    const g = db.getGraphData();
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
  });

  it('functions with no edges are returned via fallback', () => {
    const { id: fid } = db.upsertFile('/ws/c.ts', 'typescript', 30, Date.now(), 'h3');
    const syms: ExtractedSymbol[] = [
      { name: 'alpha', kind: 'function', startLine: 1, endLine: 5, loc: 5, children: [] },
      { name: 'beta',  kind: 'function', startLine: 6, endLine: 10, loc: 5, children: [] },
      { name: 'gamma', kind: 'function', startLine: 11, endLine: 15, loc: 5, children: [] },
    ];
    db.insertSymbols(fid, syms);

    const g = db.getGraphData();
    expect(g.nodes.length).toBeGreaterThanOrEqual(3);
    const names = g.nodes.map(n => n.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).toContain('gamma');
  });

  it('entry points have no incoming edges; callees are included', () => {
    const { id: fid } = db.upsertFile('/ws/d.ts', 'typescript', 30, Date.now(), 'h4');
    const [aId, bId, cId] = db.insertSymbols(fid, [
      { name: 'entry', kind: 'function', startLine: 1,  endLine: 5,  loc: 5, children: [] },
      { name: 'callee1', kind: 'function', startLine: 6,  endLine: 10, loc: 5, children: [] },
      { name: 'callee2', kind: 'function', startLine: 11, endLine: 15, loc: 5, children: [] },
    ]);
    db.insertEdges([
      { sourceId: aId, targetId: bId, kind: 'call' },
      { sourceId: aId, targetId: cId, kind: 'call' },
    ]);

    const g = db.getGraphData();
    const nodeIds = g.nodes.map(n => n.id);
    expect(nodeIds).toContain(aId);
    expect(nodeIds).toContain(bId);
    expect(nodeIds).toContain(cId);
    // entry has no incoming edge → it's an entry point
    expect(g.rootIds).toContain(aId);
  });

  it('getGraphData(rootIds) returns root + its direct callees only', () => {
    const { id: fid } = db.upsertFile('/ws/e.ts', 'typescript', 50, Date.now(), 'h5');
    const [r, c1, c2, unrelated] = db.insertSymbols(fid, [
      { name: 'root',      kind: 'function', startLine: 1,  endLine: 5,  loc: 5, children: [] },
      { name: 'callee1',   kind: 'function', startLine: 6,  endLine: 10, loc: 5, children: [] },
      { name: 'callee2',   kind: 'function', startLine: 11, endLine: 15, loc: 5, children: [] },
      { name: 'unrelated', kind: 'function', startLine: 16, endLine: 20, loc: 5, children: [] },
    ]);
    db.insertEdges([
      { sourceId: r,  targetId: c1, kind: 'call' },
      { sourceId: r,  targetId: c2, kind: 'call' },
    ]);

    const g = db.getGraphData([r]);
    const ids = g.nodes.map(n => n.id);
    expect(ids).toContain(r);
    expect(ids).toContain(c1);
    expect(ids).toContain(c2);
    expect(ids).not.toContain(unrelated);
  });
});

// ── searchSymbols ─────────────────────────────────────────────────────────────

describe('searchSymbols', () => {
  beforeEach(() => {
    const { id: fid } = db.upsertFile('/ws/f.ts', 'typescript', 50, Date.now(), 'hS');
    db.insertSymbols(fid, [
      { name: 'parseFoo',   kind: 'function', startLine: 1,  endLine: 5,  loc: 5, children: [] },
      { name: 'parseBar',   kind: 'function', startLine: 6,  endLine: 10, loc: 5, children: [] },
      { name: 'FooParser',  kind: 'class',    startLine: 11, endLine: 20, loc: 10, children: [] },
      { name: 'unrelated',  kind: 'function', startLine: 21, endLine: 25, loc: 5, children: [] },
    ]);
  });

  it('exact name match returns the function', () => {
    const g = db.searchSymbols('parseFoo');
    expect(g.nodes.map(n => n.name)).toContain('parseFoo');
  });

  it('LIKE prefix matches multiple functions', () => {
    const g = db.searchSymbols('parse');
    const names = g.nodes.map(n => n.name);
    expect(names).toContain('parseFoo');
    expect(names).toContain('parseBar');
  });

  it('class kind is excluded from search results', () => {
    const g = db.searchSymbols('FooParser');
    expect(g.nodes).toHaveLength(0);
  });

  it('no match returns empty graph', () => {
    const g = db.searchSymbols('zzz_no_match');
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
  });
});


// ── getSymbolInfo ─────────────────────────────────────────────────────────────

describe('getSymbolInfo', () => {
  it('returns all fields correctly', () => {
    const { id: fid } = db.upsertFile('/ws/i.ts', 'typescript', 30, Date.now(), 'hI');
    const [symId] = db.insertSymbols(fid, [
      { name: 'myFn', kind: 'function', startLine: 5, endLine: 12, loc: 8, children: [] },
    ]);
    const info = db.getSymbolInfo(symId);
    expect(info).not.toBeNull();
    expect(info!.name).toBe('myFn');
    expect(info!.filePath).toBe('/ws/i.ts');
    expect(info!.startLine).toBe(5);
    expect(info!.endLine).toBe(12);
    expect(info!.language).toBe('typescript');
    expect(info!.fileHash).toBe('hI');
  });

  it('returns null for unknown symbol ID', () => {
    expect(db.getSymbolInfo(99999)).toBeNull();
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('insertSymbols with empty array returns empty IDs', () => {
    const { id: fid } = db.upsertFile('/ws/empty.ts', 'typescript', 5, Date.now(), 'hE');
    const ids = db.insertSymbols(fid, []);
    expect(ids).toEqual([]);
  });

  it('markCycleEdges with empty array is a no-op', () => {
    expect(() => db.markCycleEdges([])).not.toThrow();
  });

  it('close() twice does not throw', () => {
    db.close();
    expect(() => db.close()).not.toThrow();
  });

  it('insertMetrics then getGraphData includes complexity fields', () => {
    const { id: fid } = db.upsertFile('/ws/m.ts', 'typescript', 20, Date.now(), 'hM');
    const [symId] = db.insertSymbols(fid, [
      { name: 'measured', kind: 'function', startLine: 1, endLine: 10, loc: 10, children: [] },
    ]);
    db.insertMetrics(symId, { cyclomatic: 5, cognitive: 3, paramCount: 2, maxLoopDepth: 1 });

    const g = db.getGraphData();
    const n = g.nodes.find(n => n.name === 'measured');
    expect(n).toBeDefined();
    expect(n!.complexity).toBe(5);
    expect(n!.cognitiveComplexity).toBe(3);
    expect(n!.parameterCount).toBe(2);
    expect(n!.maxLoopDepth).toBe(1);
  });

  it('upsertChurn then getGraphData includes churn fields', () => {
    const { id: fid } = db.upsertFile('/ws/ch.ts', 'typescript', 10, Date.now(), 'hCh');
    db.insertSymbols(fid, [
      { name: 'churned', kind: 'function', startLine: 1, endLine: 5, loc: 5, children: [] },
    ]);
    db.upsertChurn(fid, { commitCount: 42, recentCommitCount: 7, lastAuthor: 'dev@example.com', lastCommitDate: 1700000000 });

    const g = db.getGraphData();
    const n = g.nodes.find(n => n.name === 'churned');
    expect(n).toBeDefined();
    expect(n!.churnCount).toBe(42);
    expect(n!.recentChurnCount).toBe(7);
  });
});
