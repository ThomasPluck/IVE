import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { IVEDatabase } from '../indexer/database.js';
import { handleToolCall } from '../mcp/tools.js';
import type { ExtractedSymbol } from '../parser/symbolExtractor.js';

const EXTENSION_PATH = path.resolve('node_modules/sql.js');

let tmpDir: string;
let db: IVEDatabase;

function call(tool: string, args: Record<string, unknown> = {}): string {
  return handleToolCall(db, tmpDir, tool, args).content[0].text;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ive-mcp-test-'));
  db = new IVEDatabase(tmpDir, EXTENSION_PATH);
  await db.open();

  const { id: fid } = db.upsertFile(path.join(tmpDir, 'src/parser/foo.ts'), 'typescript', 30, Date.now(), 'h1');
  const { id: fid2 } = db.upsertFile(path.join(tmpDir, 'src/indexer/bar.ts'), 'typescript', 20, Date.now(), 'h2');

  const [id1, id2] = db.insertSymbols(fid, [
    { name: 'parseFoo', kind: 'function', startLine: 1, endLine: 10, loc: 10, children: [] },
    { name: 'parseBar', kind: 'function', startLine: 11, endLine: 20, loc: 10, children: [] },
  ]);

  const [id3] = db.insertSymbols(fid2, [
    { name: 'indexAll', kind: 'function', startLine: 1, endLine: 15, loc: 15, children: [] },
  ]);

  db.insertEdges([
    { sourceId: id3, targetId: id1, kind: 'call' },
    { sourceId: id1, targetId: id2, kind: 'call' },
  ]);

  db.insertMetrics(id1, { cyclomatic: 5, cognitive: 3, paramCount: 2, maxLoopDepth: 1 });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ive_search', () => {
  it('finds symbols by name substring', () => {
    const out = call('ive_search', { query: 'parse' });
    expect(out).toContain('Found 2 symbols');
    expect(out).toContain('parseFoo');
    expect(out).toContain('parseBar');
  });

  it('returns message for no match', () => {
    const out = call('ive_search', { query: 'zzz' });
    expect(out).toContain('No symbols matching');
  });
});

describe('ive_get_symbol', () => {
  it('returns symbol detail with structural metrics', () => {
    const search = call('ive_search', { query: 'parseFoo' });
    const idMatch = search.match(/\[(\d+)\] parseFoo/);
    expect(idMatch).not.toBeNull();
    const id = Number(idMatch![1]);

    const out = call('ive_get_symbol', { id });
    expect(out).toContain('=== parseFoo ===');
    expect(out).toContain('Fan-in:');
    expect(out).toContain('CC: 5');
  });

  it('returns error for missing symbol', () => {
    const out = call('ive_get_symbol', { id: 99999 });
    expect(out).toContain('Error');
  });
});

describe('ive_get_callers / ive_get_callees', () => {
  it('returns callers of a function', () => {
    const search = call('ive_search', { query: 'parseFoo' });
    const id = Number(search.match(/\[(\d+)\] parseFoo/)![1]);

    const out = call('ive_get_callers', { id });
    expect(out).toContain('Callers of parseFoo');
    expect(out).toContain('indexAll');
  });

  it('returns callees of a function', () => {
    const search = call('ive_search', { query: 'indexAll' });
    const id = Number(search.match(/\[(\d+)\] indexAll/)![1]);

    const out = call('ive_get_callees', { id });
    expect(out).toContain('Callees of indexAll');
    expect(out).toContain('parseFoo');
  });
});

describe('ive_get_coverage', () => {
  it('returns readable coverage report', () => {
    const out = call('ive_get_coverage');
    expect(out).toContain('Project Coverage');
    expect(out).toContain('Total functions: 3');
    expect(out).toContain('Entry points:');
  });
});

describe('ive_get_dead_code', () => {
  it('reports when no dead code', () => {
    const out = call('ive_get_dead_code');
    expect(out).toContain('No dead code found');
  });
});

describe('ive_get_metrics', () => {
  it('returns metrics for a specific symbol', () => {
    const search = call('ive_search', { query: 'parseFoo' });
    const id = Number(search.match(/\[(\d+)\] parseFoo/)![1]);

    const out = call('ive_get_metrics', { id });
    expect(out).toContain('Metrics for parseFoo');
    expect(out).toContain('Fan-in: 1');
    expect(out).toContain('Fan-out: 1');
    expect(out).toContain('Coupling: 1');
  });

  it('returns top metrics table when no id', () => {
    const out = call('ive_get_metrics');
    expect(out).toContain('Top');
    expect(out).toContain('by coupling');
  });
});

describe('ive_get_module_boundaries', () => {
  it('detects cross-module edges', () => {
    const out = call('ive_get_module_boundaries');
    expect(out).toContain('Cross-module call edges');
    expect(out).toContain('src/indexer');
    expect(out).toContain('src/parser');
  });
});

describe('ive_annotate + ive_get_annotations', () => {
  it('creates and retrieves annotations', () => {
    const search = call('ive_search', { query: 'parseFoo' });
    const id = Number(search.match(/\[(\d+)\] parseFoo/)![1]);

    const annotated = call('ive_annotate', {
      symbolId: id,
      tags: ['parser', 'core'],
      label: 'Main parser entry point',
      explanation: 'Handles all foo parsing logic',
    });
    expect(annotated).toContain('parseFoo');
    expect(annotated).toContain('parser, core');

    const annotations = call('ive_get_annotations', { symbolId: id });
    expect(annotations).toContain('Main parser entry point');
  });

  it('updates existing annotation', () => {
    const search = call('ive_search', { query: 'parseFoo' });
    const id = Number(search.match(/\[(\d+)\] parseFoo/)![1]);

    call('ive_annotate', { symbolId: id, tags: ['v1'], label: 'first', explanation: 'first version' });
    call('ive_annotate', { symbolId: id, tags: ['v2'], label: 'updated', explanation: 'second version' });

    const annotations = call('ive_get_annotations', { symbolId: id });
    expect(annotations).toContain('updated');
    expect(annotations).not.toContain('first version');
  });
});
