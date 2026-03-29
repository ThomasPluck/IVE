#!/usr/bin/env node
/**
 * CLI indexer — creates .ive/index.db without VSCode.
 * Usage: node dist/ive-index.js [--workspace <path>]
 */
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import Parser from 'web-tree-sitter';
import { IVEDatabase } from '../indexer/database.js';
import { getLanguageForFile, getLanguageConfig, getSupportedExtensions } from '../parser/languages.js';
import { extractSymbols } from '../parser/symbolExtractor.js';
import { extractRawCallEdges, resolveEdges } from '../parser/callGraphExtractor.js';
import { computeMetrics } from '../parser/complexityCalculator.js';
import { detectCycles } from '../indexer/cycleDetector.js';

const DEFAULT_EXCLUDES = new Set([
  'node_modules', '.git', '.ive', 'dist', 'build', 'out', '.next', '.nuxt',
  '.svelte-kit', '.venv', 'venv', 'env', '.env', '__pycache__', '.mypy_cache',
  '.pytest_cache', '.ruff_cache', 'target', '.gradle', '.idea', '.vs',
  'coverage', '.nyc_output', '.turbo', '.cache', '.parcel-cache', 'vendor',
  'Pods', '.dart_tool', '.pub-cache', 'site-packages', 'egg-info', '.tox',
  'htmlcov', '.terraform',
]);

function findFiles(dir: string, extensions: Set<string>, results: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && DEFAULT_EXCLUDES.has(entry.name)) continue;
    if (DEFAULT_EXCLUDES.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findFiles(full, extensions, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (extensions.has(ext)) results.push(full);
    }
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const wsIdx = args.indexOf('--workspace');
  const workspacePath = wsIdx !== -1 ? path.resolve(args[wsIdx + 1]) : process.cwd();
  const extensionRoot = path.join(__dirname, '..');

  console.error(`IVE CLI: Indexing ${workspacePath}...`);

  // Init tree-sitter
  const treeSitterWasm = path.join(extensionRoot, 'dist', 'grammars', 'tree-sitter.wasm');
  if (!fs.existsSync(treeSitterWasm)) {
    // Fallback: look relative to __dirname (bundled)
    const fallback = path.join(__dirname, 'grammars', 'tree-sitter.wasm');
    if (!fs.existsSync(fallback)) {
      console.error('IVE CLI: tree-sitter.wasm not found. Run `npm run build` first.');
      process.exit(1);
    }
    await Parser.init({ locateFile: () => fallback });
  } else {
    await Parser.init({ locateFile: () => treeSitterWasm });
  }

  const parser = new Parser();
  const loadedLangs = new Map<string, Parser.Language>();

  async function loadLanguage(language: string): Promise<boolean> {
    if (loadedLangs.has(language)) return true;
    const config = getLanguageConfig(language);
    if (!config) return false;
    const wasmPath = path.join(extensionRoot, 'dist', 'grammars', config.wasmFile);
    if (!fs.existsSync(wasmPath)) return false;
    const lang = await Parser.Language.load(wasmPath);
    loadedLangs.set(language, lang);
    return true;
  }

  // Open database
  const wasmDbPath = path.join(extensionRoot, 'dist', 'sql-wasm.wasm');
  const t0 = Date.now();
  const phases: Array<{ name: string; ms: number }> = [];
  const time = <T>(name: string, fn: () => T): T => { const s = Date.now(); const r = fn(); phases.push({ name, ms: Date.now() - s }); return r; };
  const timeAsync = async <T>(name: string, fn: () => Promise<T>): Promise<T> => { const s = Date.now(); const r = await fn(); phases.push({ name, ms: Date.now() - s }); return r; };

  const db = new IVEDatabase(workspacePath, extensionRoot);
  await timeAsync('db-open', () => db.open());
  db.clear();

  // Find files
  const extSet = new Set(getSupportedExtensions());
  const files = time('scan', () => findFiles(workspacePath, extSet));
  console.error(`IVE CLI: Found ${files.length} files`);

  interface ProcessedFile {
    fileId: number;
    filePath: string;
    tree: Parser.Tree;
    language: string;
  }

  const processed: ProcessedFile[] = [];

  for (const filePath of files) {
    const language = getLanguageForFile(filePath);
    if (!language) continue;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const loc = content.split('\n').length;
      const hash = crypto.createHash('md5').update(content).digest('hex');
      const stat = fs.statSync(filePath);

      const { id: fileId, changed } = db.upsertFile(filePath, language, loc, stat.mtimeMs, hash);

      if (!changed) continue; // File unchanged — skip parse

      if (!(await loadLanguage(language))) continue;
      parser.setLanguage(loadedLangs.get(language)!);
      const tree = parser.parse(content);
      if (!tree) continue;

      const symbols = extractSymbols(tree, language);
      db.insertSymbols(fileId, symbols);
      processed.push({ fileId, filePath, tree, language });
    } catch (err) {
      console.error(`IVE CLI: Error processing ${filePath}:`, err);
    }
  }

  console.error(`IVE CLI: Parsed ${processed.length} files, extracting call graph...`);

  // Pass 2: edges + metrics
  let edgeCount = 0;
  time('edges+metrics', () => {
    const allRawEdges = [];
    for (const { fileId, tree, language } of processed) {
      const symbols = db.getSymbolsByFileId(fileId);
      if (symbols.length === 0) continue;

      const metrics = computeMetrics(tree, language, symbols);
      for (const m of metrics) {
        db.insertMetrics(m.symbolId, { cyclomatic: m.cyclomatic, cognitive: m.cognitive, paramCount: m.paramCount, maxLoopDepth: m.maxLoopDepth });
      }

      const rawEdges = extractRawCallEdges(tree, language, symbols);
      allRawEdges.push(...rawEdges);
    }

    const resolvedEdges = resolveEdges(allRawEdges, db);
    db.insertEdges(resolvedEdges);
    edgeCount = resolvedEdges.length;
  });

  // Pass 3: cycles
  time('cycles', () => {
    const allEdges = db.getAllEdges();
    const cycleNodes = detectCycles(allEdges);
    if (cycleNodes.size > 0) {
      db.markCycleEdges([...cycleNodes]);
    }
  });

  time('persist', () => db.persist());

  const perf = { timestamp: Date.now(), totalFiles: files.length, changedFiles: processed.length, phases, totalMs: Date.now() - t0, skipped: false };
  try { db.savePerf(perf); } catch { /* non-critical */ }

  const coverage = db.getProjectCoverage();
  const perfSummary = phases.map(p => `${p.name}=${p.ms}ms`).join(' ');
  console.error(`IVE CLI: Done in ${perf.totalMs}ms [${perfSummary}]`);
  console.error(`IVE CLI: ${coverage.totalFunctions} functions, ${edgeCount} edges, ${coverage.coveragePercent}% coverage, ${coverage.deadCodeIds.length} dead.`);

  db.close();
}

main().catch((err) => {
  console.error('IVE CLI failed:', err);
  process.exit(1);
});
