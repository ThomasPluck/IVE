/**
 * Self-audit: IVE's graph analysis validates IVE's own structure.
 *
 * This test builds a graph mirroring IVE's actual module architecture
 * and asserts that its structural metrics meet health thresholds.
 * When IVE's code changes, this test should be updated to reflect reality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { IVEDatabase } from '../indexer/database.js';
import type { ExtractedSymbol } from '../parser/symbolExtractor.js';
import {
  computeReachability,
  computeStructuralMetrics,
  detectModuleBoundaries,
} from '../indexer/graphAnalyzer.js';

const EXTENSION_PATH = path.resolve('node_modules/sql.js');

let tmpDir: string;
let db: IVEDatabase;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ive-self-audit-'));
  db = new IVEDatabase(tmpDir, EXTENSION_PATH);
  await db.open();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Build a graph that mirrors IVE's actual module structure:
 *
 * src/extension.ts       → IndexManager.indexWorkspace, IVEPanelProvider.resolveWebviewView
 * IndexManager            → TreeSitterParser, extractSymbols, extractRawCallEdges, resolveEdges, computeMetrics, detectCycles, getChurnForFile
 * IVEPanelProvider        → IndexManager.getGraphData, IndexManager.searchSymbols, summarizeFunction, narratePath, getDiffSummary
 * extractRawCallEdges     → findNodeAtRange, collectCallees
 * computeMetrics          → findNodeAtRange, countDecisionPoints, computeCognitive
 * summarizeFunction       → callLLM
 * narratePath             → callLLM
 * graphAnalyzer           → computeReachability, computeStructuralMetrics, detectModuleBoundaries
 */
function buildIVEGraph() {
  const ws = tmpDir;

  // Files representing IVE modules
  const { id: extFile } = db.upsertFile(path.join(ws, 'src/extension.ts'), 'typescript', 40, Date.now(), 'h1');
  const { id: idxFile } = db.upsertFile(path.join(ws, 'src/indexer/IndexManager.ts'), 'typescript', 330, Date.now(), 'h2');
  const { id: panelFile } = db.upsertFile(path.join(ws, 'src/webview/IVEPanelProvider.ts'), 'typescript', 250, Date.now(), 'h3');
  const { id: parserFile } = db.upsertFile(path.join(ws, 'src/parser/symbolExtractor.ts'), 'typescript', 156, Date.now(), 'h4');
  const { id: cgFile } = db.upsertFile(path.join(ws, 'src/parser/callGraphExtractor.ts'), 'typescript', 120, Date.now(), 'h5');
  const { id: ccFile } = db.upsertFile(path.join(ws, 'src/parser/complexityCalculator.ts'), 'typescript', 145, Date.now(), 'h6');
  const { id: cycleFile } = db.upsertFile(path.join(ws, 'src/indexer/cycleDetector.ts'), 'typescript', 77, Date.now(), 'h7');
  const { id: diffFile } = db.upsertFile(path.join(ws, 'src/indexer/diffAnalyzer.ts'), 'typescript', 57, Date.now(), 'h8');
  const { id: llmFile } = db.upsertFile(path.join(ws, 'src/ai/llmClient.ts'), 'typescript', 118, Date.now(), 'h9');
  const { id: astFile } = db.upsertFile(path.join(ws, 'src/parser/astUtils.ts'), 'typescript', 24, Date.now(), 'h10');
  const { id: gaFile } = db.upsertFile(path.join(ws, 'src/indexer/graphAnalyzer.ts'), 'typescript', 200, Date.now(), 'h11');
  const { id: dbFile } = db.upsertFile(path.join(ws, 'src/indexer/database.ts'), 'typescript', 460, Date.now(), 'h12');

  // Symbols: key functions from each module
  const syms: Record<string, { fileId: number; sym: ExtractedSymbol }> = {};
  const addSym = (name: string, fileId: number, lines: [number, number]) => {
    syms[name] = {
      fileId,
      sym: { name, kind: 'function', startLine: lines[0], endLine: lines[1], loc: lines[1] - lines[0] + 1, children: [] },
    };
  };

  // Extension entry points
  addSym('activate', extFile, [1, 40]);

  // IndexManager
  addSym('indexWorkspace', idxFile, [72, 142]);
  addSym('indexFile', idxFile, [144, 181]);
  addSym('processFile', idxFile, [298, 329]);

  // IVEPanelProvider
  addSym('resolveWebviewView', panelFile, [20, 138]);
  addSym('onWebviewReady', panelFile, [179, 209]);
  addSym('showDiff', panelFile, [145, 173]);

  // Parser modules
  addSym('extractSymbols', parserFile, [14, 47]);
  addSym('extractRawCallEdges', cgFile, [17, 48]);
  addSym('resolveEdges', cgFile, [55, 77]);
  addSym('computeMetrics', ccFile, [18, 49]);
  addSym('findNodeAtRange', astFile, [7, 24]);

  // Indexer modules
  addSym('detectCycles', cycleFile, [11, 77]);
  addSym('getDiffSummary', diffFile, [10, 57]);

  // AI
  addSym('summarizeFunction', llmFile, [106, 109]);
  addSym('narratePath', llmFile, [111, 118]);
  addSym('callLLM', llmFile, [89, 104]);

  // Graph analyzer
  addSym('computeReachability', gaFile, [38, 55]);
  addSym('computeStructuralMetrics', gaFile, [62, 115]);
  addSym('detectModuleBoundaries', gaFile, [120, 140]);

  // Database
  addSym('getGraphData', dbFile, [220, 290]);
  addSym('getProjectCoverage', dbFile, [350, 356]);

  // Insert all symbols and collect IDs
  const idMap = new Map<string, number>();
  for (const [name, { fileId, sym }] of Object.entries(syms)) {
    const [id] = db.insertSymbols(fileId, [sym]);
    idMap.set(name, id);
  }

  // Insert call edges
  const edges: Array<{ sourceId: number; targetId: number; kind: string }> = [];
  const edge = (from: string, to: string) => {
    const src = idMap.get(from)!;
    const tgt = idMap.get(to)!;
    if (src && tgt) edges.push({ sourceId: src, targetId: tgt, kind: 'call' });
  };

  // Extension → managers
  edge('activate', 'indexWorkspace');
  edge('activate', 'resolveWebviewView');

  // IndexManager → parsers
  edge('indexWorkspace', 'processFile');
  edge('processFile', 'extractSymbols');
  edge('indexWorkspace', 'extractRawCallEdges');
  edge('indexWorkspace', 'resolveEdges');
  edge('indexWorkspace', 'computeMetrics');
  edge('indexWorkspace', 'detectCycles');

  // IVEPanelProvider → IndexManager + AI
  edge('onWebviewReady', 'indexWorkspace');
  edge('resolveWebviewView', 'onWebviewReady');
  edge('resolveWebviewView', 'getGraphData');
  edge('resolveWebviewView', 'summarizeFunction');
  edge('resolveWebviewView', 'narratePath');
  edge('showDiff', 'getDiffSummary');
  edge('showDiff', 'getGraphData');
  edge('resolveWebviewView', 'getProjectCoverage');

  // Parser internals
  edge('extractRawCallEdges', 'findNodeAtRange');
  edge('computeMetrics', 'findNodeAtRange');

  // AI internals
  edge('summarizeFunction', 'callLLM');
  edge('narratePath', 'callLLM');

  // Graph analyzer
  edge('getProjectCoverage', 'computeReachability');
  edge('getProjectCoverage', 'computeStructuralMetrics');

  db.insertEdges(edges);

  return { idMap, ws };
}

describe('IVE self-audit', () => {
  it('IVE graph has >= 80% structural coverage', () => {
    const { idMap, ws } = buildIVEGraph();

    const allEdges = db.getAllEdges();
    const allIds = db.getAllFunctionIds();
    const entryIds = db.getEntryPointIds();

    const coverage = computeReachability(allEdges, allIds, entryIds);

    expect(coverage.totalFunctions).toBeGreaterThanOrEqual(20);
    expect(coverage.coveragePercent).toBeGreaterThanOrEqual(80);

    // These entry points should have no incoming edges
    const activateId = idMap.get('activate')!;
    expect(entryIds).toContain(activateId);
  });

  it('no function has coupling > 20 (fanIn * fanOut)', () => {
    const { ws } = buildIVEGraph();

    const allEdges = db.getAllEdges();
    const allIds = db.getAllFunctionIds();
    const entryIds = db.getEntryPointIds();
    const filePaths = db.getSymbolFilePaths();

    const metrics = computeStructuralMetrics(allEdges, allIds, entryIds, filePaths, ws);

    for (const [id, m] of metrics) {
      expect(m.coupling, `function ${m.id} coupling=${m.coupling}`).toBeLessThanOrEqual(20);
    }
  });

  it('max depth from entry point <= 6', () => {
    const { ws } = buildIVEGraph();

    const allEdges = db.getAllEdges();
    const allIds = db.getAllFunctionIds();
    const entryIds = db.getEntryPointIds();
    const filePaths = db.getSymbolFilePaths();

    const metrics = computeStructuralMetrics(allEdges, allIds, entryIds, filePaths, ws);

    let maxDepth = 0;
    for (const [, m] of metrics) {
      if (m.depthFromEntry > maxDepth) maxDepth = m.depthFromEntry;
    }

    expect(maxDepth).toBeLessThanOrEqual(6);
  });

  it('module boundaries exist between parser, indexer, ai, and webview', () => {
    const { ws } = buildIVEGraph();

    const allEdges = db.getAllEdges();
    const allIds = db.getAllFunctionIds();
    const entryIds = db.getEntryPointIds();
    const filePaths = db.getSymbolFilePaths();

    const metrics = computeStructuralMetrics(allEdges, allIds, entryIds, filePaths, ws);
    const moduleMap = new Map<number, string>();
    for (const [id, m] of metrics) moduleMap.set(id, m.module);

    const boundaries = detectModuleBoundaries(allEdges, moduleMap);
    expect(boundaries.length).toBeGreaterThan(0);

    const modules = new Set(boundaries.flatMap(b => [b.sourceModule, b.targetModule]));
    expect(modules.size).toBeGreaterThanOrEqual(3);
  });

  it('every dead code function is identified and accountable', () => {
    const { idMap, ws } = buildIVEGraph();

    const coverage = db.getProjectCoverage();

    // detectModuleBoundaries is a leaf utility called from getProjectCoverage path
    // indexFile is not called from activate — it's called on file-save events (VSCode API)
    const expectedDead = new Set(['indexFile', 'detectModuleBoundaries']);

    for (const deadId of coverage.deadCodeIds) {
      const allFns = db.getAllFunctionIds();
      const filePaths = db.getSymbolFilePaths();
      // Find the name for this dead ID
      let deadName = '';
      for (const [name, id] of idMap) {
        if (id === deadId) { deadName = name; break; }
      }
      expect(expectedDead.has(deadName), `unexpected dead code: ${deadName} (id=${deadId})`).toBe(true);
    }
  });

  it('structural metrics are available via database getProjectCoverage()', () => {
    buildIVEGraph();

    const coverage = db.getProjectCoverage();
    expect(coverage.totalFunctions).toBeGreaterThan(0);
    expect(coverage.entryPointIds.length).toBeGreaterThan(0);
    expect(coverage.coveragePercent).toBeGreaterThan(0);
  });

  it('structural metrics are available via database getStructuralMetrics()', () => {
    buildIVEGraph();

    const metrics = db.getStructuralMetrics();
    expect(metrics.size).toBeGreaterThan(0);

    for (const [, m] of metrics) {
      expect(m.module).toBeTruthy();
      expect(m.fanIn).toBeGreaterThanOrEqual(0);
      expect(m.fanOut).toBeGreaterThanOrEqual(0);
      expect(m.coupling).toBeGreaterThanOrEqual(0);
    }
  });
});
