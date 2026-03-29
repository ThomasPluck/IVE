import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { TreeSitterParser } from '../parser/TreeSitterParser.js';
import { extractSymbols } from '../parser/symbolExtractor.js';
import { getLanguageForFile, getSupportedExtensions } from '../parser/languages.js';
import { extractRawCallEdges, resolveEdges } from '../parser/callGraphExtractor.js';
import { computeMetrics } from '../parser/complexityCalculator.js';
import { isGitRepo, getChurnForFile } from './gitChurnAnalyzer.js';
import { detectCycles } from './cycleDetector.js';
import { IVEDatabase } from './database.js';
import type { GraphData } from '../types.js';
import * as path from 'path';
import type Parser from 'web-tree-sitter';

/** Directories always excluded, even without .iveignore */
const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  '.ive',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.venv',
  'venv',
  'env',
  '.env',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'target',
  '.gradle',
  '.idea',
  '.vs',
  'coverage',
  '.nyc_output',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'vendor',
  'Pods',
  '.dart_tool',
  '.pub-cache',
  'site-packages',
  'egg-info',
  '.tox',
  'htmlcov',
  '.terraform',
];

interface ProcessedFile {
  fileId: number;
  filePath: string;
  tree: Parser.Tree;
  language: string;
}

export interface IndexPerf {
  timestamp: number;
  totalFiles: number;
  changedFiles: number;
  phases: Array<{ name: string; ms: number }>;
  totalMs: number;
  skipped: boolean;
}

export class IndexManager {
  private parser: TreeSitterParser;
  private db: IVEDatabase | undefined;
  private initialized = false;
  private graphData: GraphData | undefined;
  private lastPerf: IndexPerf | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.parser = new TreeSitterParser(context.extensionUri);
  }

  async indexWorkspace(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return;

    const workspacePath = workspaceFolders[0].uri.fsPath;
    const t0 = Date.now();
    const phases: Array<{ name: string; ms: number }> = [];
    const time = (name: string, fn: () => void) => { const s = Date.now(); fn(); phases.push({ name, ms: Date.now() - s }); };
    const timeAsync = async (name: string, fn: () => Promise<void>) => { const s = Date.now(); await fn(); phases.push({ name, ms: Date.now() - s }); };

    if (!this.initialized) {
      await timeAsync('init', async () => {
        await this.parser.init();
        this.db = new IVEDatabase(workspacePath, this.context.extensionUri.fsPath);
        await this.db.open();
      });
      this.initialized = true;
    }

    let totalFiles = 0;
    const processedFiles: ProcessedFile[] = [];

    await timeAsync('scan+hash', async () => {
      const extensions = getSupportedExtensions();
      const globPattern = `**/*{${extensions.join(',')}}`;
      const excludePattern = this.buildExcludePattern(workspacePath);
      const files = await vscode.workspace.findFiles(globPattern, excludePattern);
      totalFiles = files.length;

      for (const file of files) {
        const result = await this.processFile(file);
        if (result) processedFiles.push(result);
      }
    });

    if (processedFiles.length === 0) {
      this.graphData = this.db!.getGraphData();
      this.lastPerf = { timestamp: Date.now(), totalFiles, changedFiles: 0, phases, totalMs: Date.now() - t0, skipped: true };
      console.log(`IVE: No files changed (${this.lastPerf.totalMs}ms scan). Graph: ${this.graphData.nodes.length} nodes, ${this.graphData.edges.length} edges.`);
      return;
    }

    const isGit = isGitRepo(workspacePath);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `IVE: Indexing ${processedFiles.length} changed files`,
        cancellable: false,
      },
      async (progress) => {
        if (isGit) {
          await timeAsync('git-churn', async () => {
            progress.report({ increment: 0, message: 'Analyzing git history...' });
            for (const { fileId, filePath } of processedFiles) {
              const churn = getChurnForFile(workspacePath, filePath);
              this.db!.upsertChurn(fileId, churn);
            }
          });
        }

        await timeAsync('edges+metrics', async () => {
          progress.report({ increment: 40, message: 'Building call graph...' });
          await this.extractEdgesAndMetrics(processedFiles);
        });

        time('cycles', () => {
          progress.report({ increment: 30, message: 'Detecting cycles...' });
          const allEdges = this.db!.getAllEdges();
          const cycleNodes = detectCycles(allEdges);
          if (cycleNodes.size > 0) {
            this.db!.markCycleEdges([...cycleNodes]);
          }
        });

        time('persist', () => {
          this.db!.persist();
        });

        progress.report({ increment: 30, message: 'Done' });
      }
    );

    this.graphData = this.db!.getGraphData();
    this.lastPerf = { timestamp: Date.now(), totalFiles, changedFiles: processedFiles.length, phases, totalMs: Date.now() - t0, skipped: false };

    try { this.db!.savePerf(this.lastPerf); } catch { /* non-critical */ }

    const perfSummary = phases.map(p => `${p.name}=${p.ms}ms`).join(' ');
    console.log(`IVE: ${processedFiles.length}/${totalFiles} files indexed in ${this.lastPerf.totalMs}ms [${perfSummary}]`);
  }

  async indexFile(uri: vscode.Uri): Promise<void> {
    if (!this.initialized || !this.db) return;

    const language = getLanguageForFile(uri.fsPath);
    if (!language) return;

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const result = await this.processFile(uri);
    if (result) {
      const symbols = this.db.getSymbolsByFileId(result.fileId);
      this.db.deleteEdgesForFile(result.fileId);

      const rawEdges = extractRawCallEdges(result.tree, result.language, symbols);
      const edges = resolveEdges(rawEdges, this.db);
      this.db.insertEdges(edges);

      const metrics = computeMetrics(result.tree, result.language, symbols);
      for (const m of metrics) {
        this.db.insertMetrics(m.symbolId, { cyclomatic: m.cyclomatic, cognitive: m.cognitive, paramCount: m.paramCount, maxLoopDepth: m.maxLoopDepth });
      }

      // Re-run churn for this file
      if (workspacePath && isGitRepo(workspacePath)) {
        const churn = getChurnForFile(workspacePath, result.filePath);
        this.db.upsertChurn(result.fileId, churn);
      }

      // Re-run cycle detection over the full graph
      const allEdges = this.db.getAllEdges();
      const cycleNodes = detectCycles(allEdges);
      if (cycleNodes.size > 0) {
        this.db.markCycleEdges([...cycleNodes]);
      }
    }

    this.db.persist();
    this.graphData = this.db.getGraphData();
  }

  getGraphData(): GraphData | undefined {
    return this.graphData;
  }

  getLastPerf(): IndexPerf | undefined {
    return this.lastPerf;
  }

  searchSymbols(query: string): GraphData {
    if (!this.db) return { nodes: [], edges: [], rootIds: [] };
    return this.db.searchSymbols(query);
  }

  getGraphDataForSymbol(symbolId: number): GraphData {
    if (!this.db) return { nodes: [], edges: [], rootIds: [] };
    return this.db.getGraphData([symbolId]);
  }

  getWorkspacePath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  getDatabase(): IVEDatabase | undefined {
    return this.db;
  }

  dispose(): void {
    this.db?.close();
  }

  private async extractEdgesAndMetrics(processedFiles: ProcessedFile[]): Promise<void> {
    if (!this.db) return;

    const allRawEdges = [];

    for (const { fileId, tree, language } of processedFiles) {
      const symbols = this.db.getSymbolsByFileId(fileId);
      if (symbols.length === 0) continue;

      // Complexity metrics
      const metrics = computeMetrics(tree, language, symbols);
      for (const m of metrics) {
        this.db.insertMetrics(m.symbolId, {
          cyclomatic: m.cyclomatic,
          cognitive: m.cognitive,
          paramCount: m.paramCount,
          maxLoopDepth: m.maxLoopDepth,
        });
      }

      // Raw call edges (names not yet resolved)
      const rawEdges = extractRawCallEdges(tree, language, symbols);
      allRawEdges.push(...rawEdges);
    }

    // Resolve all edges now that all symbols are in the DB
    const resolvedEdges = resolveEdges(allRawEdges, this.db);
    this.db.insertEdges(resolvedEdges);

    console.log(`IVE: Extracted ${resolvedEdges.length} call edges from ${allRawEdges.length} raw call sites.`);
  }

  private buildExcludePattern(workspacePath: string): string {
    const excludes = [...DEFAULT_EXCLUDES];

    const ignorePaths = [
      path.join(workspacePath, '.ive', 'ignore'),
      path.join(workspacePath, '.iveignore'),
    ];
    for (const ignorePath of ignorePaths) {
      if (fs.existsSync(ignorePath)) {
        const content = fs.readFileSync(ignorePath, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            excludes.push(trimmed);
          }
        }
        break;
      }
    }

    const gitignorePath = path.join(workspacePath, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim().replace(/\/$/, '');
        if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('!') && !trimmed.includes('*')) {
          if (!excludes.includes(trimmed)) {
            excludes.push(trimmed);
          }
        }
      }
    }

    const patterns = excludes.map((dir) => {
      if (dir.includes('*')) return dir;
      return `**/${dir}/**`;
    });

    return `{${patterns.join(',')}}`;
  }

  private async processFile(uri: vscode.Uri): Promise<ProcessedFile | null> {
    if (!this.db) return null;

    const filePath = uri.fsPath;
    const language = getLanguageForFile(filePath);
    if (!language) return null;

    try {
      const contentBytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(contentBytes).toString('utf-8');
      const loc = content.split('\n').length;
      const hash = crypto.createHash('md5').update(content).digest('hex');
      const stat = await vscode.workspace.fs.stat(uri);

      const { id: fileId, changed } = this.db.upsertFile(filePath, language, loc, stat.mtime, hash);

      if (!changed) return null; // File unchanged — skip parse, keep existing symbols/edges

      const loaded = await this.parser.loadLanguage(language);
      if (!loaded) return null;

      const tree = this.parser.parse(content, language);
      if (!tree) return null;

      const symbols = extractSymbols(tree, language);
      this.db.insertSymbols(fileId, symbols);

      return { fileId, filePath, tree, language };
    } catch (err) {
      console.error(`IVE: Error processing ${filePath}:`, err);
      return null;
    }
  }
}
