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
    expect(out).toContain('Total functions:');
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

describe('ive_find_path', () => {
  it('finds shortest call path between two symbols', () => {
    const s1 = call('ive_search', { query: 'indexAll' });
    const s2 = call('ive_search', { query: 'parseBar' });
    const fromId = Number(s1.match(/\[(\d+)\] indexAll/)![1]);
    const toId = Number(s2.match(/\[(\d+)\] parseBar/)![1]);

    const out = call('ive_find_path', { from_id: fromId, to_id: toId });
    expect(out).toContain('Call path');
    expect(out).toContain('indexAll');
    expect(out).toContain('parseFoo');
    expect(out).toContain('parseBar');
    expect(out).toContain('3 steps');
  });

  it('diagnoses no direct path with reverse and undirected hints', () => {
    const s1 = call('ive_search', { query: 'parseBar' });
    const s2 = call('ive_search', { query: 'indexAll' });
    const fromId = Number(s1.match(/\[(\d+)\] parseBar/)![1]);
    const toId = Number(s2.match(/\[(\d+)\] indexAll/)![1]);

    const out = call('ive_find_path', { from_id: fromId, to_id: toId });
    expect(out).toContain('No direct call path');
    expect(out).toContain('Reverse path exists');
    expect(out).toContain('Undirected connection');
  });
});

describe('ive_highlight', () => {
  it('writes viewer command file and confirms', () => {
    const out = call('ive_highlight', { node_ids: [1, 2, 3] });
    expect(out).toContain('Highlighted 3 node(s)');
    expect(out).toContain('Panel must be open');

    const cmdPath = path.join(tmpDir, '.ive', 'viewer-cmd.json');
    expect(fs.existsSync(cmdPath)).toBe(true);
    const cmd = JSON.parse(fs.readFileSync(cmdPath, 'utf-8'));
    expect(cmd.action).toBe('highlight');
    expect(cmd.payload.nodeIds).toEqual([1, 2, 3]);
  });

  it('clears highlight with empty array', () => {
    const out = call('ive_highlight', { node_ids: [] });
    expect(out).toContain('Highlight cleared');

    const cmdPath = path.join(tmpDir, '.ive', 'viewer-cmd.json');
    const cmd = JSON.parse(fs.readFileSync(cmdPath, 'utf-8'));
    expect(cmd.payload.nodeIds).toEqual([]);
  });

  it('resolves node_names to IDs', () => {
    const out = call('ive_highlight', { node_names: ['parseFoo', 'indexAll'] });
    expect(out).toContain('Highlighted 2 node(s)');
    expect(out).toContain('parseFoo (id=');
    expect(out).toContain('indexAll (id=');

    const cmdPath = path.join(tmpDir, '.ive', 'viewer-cmd.json');
    const cmd = JSON.parse(fs.readFileSync(cmdPath, 'utf-8'));
    expect(cmd.payload.nodeIds).toHaveLength(2);
  });

  it('returns error for ambiguous or unknown names', () => {
    const out = call('ive_highlight', { node_names: ['nonexistent'] });
    expect(out).toContain('Error');
  });
});

describe('ive_select_path', () => {
  it('finds path and writes viewer command by ID', () => {
    const s1 = call('ive_search', { query: 'indexAll' });
    const s2 = call('ive_search', { query: 'parseBar' });
    const fromId = Number(s1.match(/\[(\d+)\] indexAll/)![1]);
    const toId = Number(s2.match(/\[(\d+)\] parseBar/)![1]);

    const out = call('ive_select_path', { from_id: fromId, to_id: toId });
    expect(out).toContain('Call path');
    expect(out).toContain('3 steps');
    expect(out).toContain('highlighted in IVE viewer');

    const cmdPath = path.join(tmpDir, '.ive', 'viewer-cmd.json');
    expect(fs.existsSync(cmdPath)).toBe(true);
    const cmd = JSON.parse(fs.readFileSync(cmdPath, 'utf-8'));
    expect(cmd.action).toBe('highlight');
    expect(cmd.payload.nodeIds).toHaveLength(3);
  });

  it('finds path by function name', () => {
    const out = call('ive_select_path', { from_name: 'indexAll', to_name: 'parseBar' });
    expect(out).toContain('Call path');
    expect(out).toContain('3 steps');
    expect(out).toContain('highlighted in IVE viewer');
    // Output uses name (id=N) format
    expect(out).toMatch(/indexAll \(id=\d+/);
    expect(out).toMatch(/parseBar \(id=\d+/);
  });

  it('diagnoses no direct path and highlights undirected connection', () => {
    const out = call('ive_select_path', { from_name: 'parseBar', to_name: 'indexAll' });
    expect(out).toContain('No direct call path');
    expect(out).toContain('Undirected connection');
    expect(out).toContain('highlighted in viewer');

    // Undirected path should be highlighted
    const cmdPath = path.join(tmpDir, '.ive', 'viewer-cmd.json');
    expect(fs.existsSync(cmdPath)).toBe(true);
  });
});

describe('ive_get_neighborhood', () => {
  it('returns neighborhood by name and highlights', () => {
    const out = call('ive_get_neighborhood', { name: 'parseFoo', depth: 1 });
    expect(out).toContain('Neighborhood of parseFoo');
    expect(out).toContain('[ROOT]');
    // parseFoo has caller indexAll and callee parseBar — both within 1 hop
    expect(out).toContain('indexAll');
    expect(out).toContain('parseBar');

    const cmdPath = path.join(tmpDir, '.ive', 'viewer-cmd.json');
    expect(fs.existsSync(cmdPath)).toBe(true);
  });

  it('returns error for unknown name', () => {
    const out = call('ive_get_neighborhood', { name: 'nonexistent' });
    expect(out).toContain('Error');
  });
});

describe('ive_suggest_highlights', () => {
  it('returns suggestions with node IDs', () => {
    const out = call('ive_suggest_highlights');
    expect(out).toContain('Suggested Highlights');
    expect(out).toContain('ive_highlight');
    // Should have at least one suggestion
    expect(out).toMatch(/1\./);
  });
});

describe('ive_highlight_cluster', () => {
  it('highlights neighborhood cluster by name', () => {
    const out = call('ive_highlight_cluster', { name: 'parseFoo', strategy: 'neighborhood' });
    expect(out).toContain('neighborhood');
    expect(out).toContain('parseFoo');
    expect(out).toContain('[ROOT]');
    expect(out).toContain('Highlighted in viewer');
  });

  it('highlights deep chain from a node', () => {
    const out = call('ive_highlight_cluster', { name: 'indexAll', strategy: 'deep_chain' });
    expect(out).toContain('Deepest chain');
    expect(out).toContain('indexAll');
    expect(out).toContain('parseBar');
  });
});
