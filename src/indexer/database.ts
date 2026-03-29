import * as path from 'path';
import * as fs from 'fs';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import { SCHEMA_SQL } from './schema.js';
import type { ExtractedSymbol } from '../parser/symbolExtractor.js';
import type { GraphNode, GraphEdge, GraphData } from '../types.js';
import { computeReachability, computeStructuralMetrics, type ProjectCoverage, type SymbolStructure } from './graphAnalyzer.js';

const GRAPH_NODE_QUERY = `SELECT s.id, s.name, s.kind, f.path, s.start_line, s.end_line, s.loc, f.language,
        m.cyclomatic_complexity, m.cognitive_complexity, m.parameter_count, m.max_loop_depth,
        gc.commit_count, gc.recent_commit_count
 FROM symbols s
 JOIN files f ON s.file_id = f.id
 LEFT JOIN metrics m ON s.id = m.symbol_id
 LEFT JOIN git_churn gc ON f.id = gc.file_id`;

const GRAPH_EDGE_QUERY = `SELECT source_symbol_id, target_symbol_id, kind, is_cycle FROM edges`;

export class IVEDatabase {
  private db: Database | undefined;
  private dbPath: string;
  private readOnly = false;
  private lastMtime = 0;
  private sqlFactory: ReturnType<typeof initSqlJs> extends Promise<infer T> ? T : never = undefined as any;
  private metricsCache: { mtime: number; data: Map<number, SymbolStructure> } | undefined;

  constructor(readonly workspacePath: string, private readonly extensionPath: string, skipInit = false) {
    this.dbPath = path.join(workspacePath, '.ive', 'index.db');
    if (!skipInit) {
      const iveDir = path.join(workspacePath, '.ive');
      initIveDir(iveDir);
    }
  }

  /** Open a read-only handle to an existing .ive/index.db (for MCP server). */
  static async openReadOnly(workspacePath: string, wasmPath: string): Promise<IVEDatabase> {
    const instance = new IVEDatabase(workspacePath, '', true);
    if (!fs.existsSync(instance.dbPath)) throw new Error(`IVE database not found: ${instance.dbPath}`);

    instance.sqlFactory = await initSqlJs({ locateFile: () => wasmPath });
    const buffer = fs.readFileSync(instance.dbPath);
    instance.db = new instance.sqlFactory.Database(buffer);
    instance.db.run('PRAGMA foreign_keys = ON');
    instance.db.run(SCHEMA_SQL);
    instance.readOnly = true;
    instance.lastMtime = fs.statSync(instance.dbPath).mtimeMs;
    return instance;
  }

  /** Re-read the DB from disk if the file changed (for MCP server hot-reload). */
  reloadIfChanged(): void {
    if (!this.readOnly || !this.sqlFactory) return;
    try {
      const currentMtime = fs.statSync(this.dbPath).mtimeMs;
      if (currentMtime === this.lastMtime) return;
      const buffer = fs.readFileSync(this.dbPath);
      this.db?.close();
      this.db = new this.sqlFactory.Database(buffer);
      this.db.run('PRAGMA foreign_keys = ON');
      this.db.run(SCHEMA_SQL);
      this.lastMtime = currentMtime;
    } catch {
      // File may be mid-write; skip this reload
    }
  }

  async open(): Promise<void> {
    const wasmPath = path.join(this.extensionPath, 'dist', 'sql-wasm.wasm');
    const SQL = await initSqlJs({
      locateFile: () => wasmPath,
    });

    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run(SCHEMA_SQL);
    this.save();
  }

  close(): void {
    if (this.db) {
      this.save();
      this.db.close();
      this.db = undefined;
    }
  }

  private save(): void {
    if (!this.db) return;
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  upsertFile(filePath: string, language: string | undefined, loc: number, lastModified: number, hash: string): { id: number; changed: boolean } {
    if (!this.db) throw new Error('Database not open');

    const existing = this.db.exec('SELECT id, hash FROM files WHERE path = ?', [filePath]);
    if (existing.length > 0 && existing[0].values.length > 0) {
      const existingId = existing[0].values[0][0] as number;
      const existingHash = existing[0].values[0][1] as string;

      if (existingHash === hash) {
        return { id: existingId, changed: false };
      }

      this.db.run(
        'UPDATE files SET language = ?, loc = ?, last_modified = ?, hash = ? WHERE id = ?',
        [language ?? null, loc, lastModified, hash, existingId]
      );

      this.db.run('DELETE FROM symbols WHERE file_id = ?', [existingId]);
      return { id: existingId, changed: true };
    }

    this.db.run(
      'INSERT INTO files (path, language, loc, last_modified, hash) VALUES (?, ?, ?, ?, ?)',
      [filePath, language ?? null, loc, lastModified, hash]
    );

    const result = this.db.exec('SELECT last_insert_rowid()');
    return { id: result[0].values[0][0] as number, changed: true };
  }

  insertSymbols(fileId: number, symbols: ExtractedSymbol[], parentId: number | null = null): number[] {
    if (!this.db) return [];

    const ids: number[] = [];
    for (const sym of symbols) {
      this.db.run(
        'INSERT INTO symbols (name, kind, file_id, start_line, end_line, loc, parent_symbol_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [sym.name, sym.kind, fileId, sym.startLine, sym.endLine, sym.loc, parentId]
      );

      const result = this.db.exec('SELECT last_insert_rowid()');
      const symId = result[0].values[0][0] as number;
      ids.push(symId);

      if (sym.children.length > 0) {
        this.insertSymbols(fileId, sym.children, symId);
      }
    }
    return ids;
  }

  upsertChurn(fileId: number, data: { commitCount: number; recentCommitCount: number; lastAuthor: string | null; lastCommitDate: number | null }): void {
    if (!this.db) return;
    this.db.run(
      'INSERT OR REPLACE INTO git_churn (file_id, commit_count, recent_commit_count, last_author, last_commit_date) VALUES (?, ?, ?, ?, ?)',
      [fileId, data.commitCount, data.recentCommitCount, data.lastAuthor, data.lastCommitDate]
    );
  }

  markCycleEdges(cycleNodeIds: number[]): void {
    if (!this.db || cycleNodeIds.length === 0) return;
    const placeholders = cycleNodeIds.map(() => '?').join(',');
    this.db.run(
      `UPDATE edges SET is_cycle = 1 WHERE source_symbol_id IN (${placeholders}) AND target_symbol_id IN (${placeholders})`,
      [...cycleNodeIds, ...cycleNodeIds]
    );
  }

  searchSymbols(query: string): GraphData {
    if (!this.db) return { nodes: [], edges: [], rootIds: [] };

    const pattern = `%${query}%`;
    const nodeResult = this.db.exec(
      `${GRAPH_NODE_QUERY} WHERE s.name LIKE ? AND s.kind IN ('function', 'method') ORDER BY s.name LIMIT 50`,
      [pattern]
    );

    const nodes = (nodeResult[0]?.values ?? []).map(rowToGraphNode);

    if (nodes.length === 0) return { nodes: [], edges: [], rootIds: [] };

    const nodeIds = nodes.map(n => n.id);
    const placeholders = nodeIds.map(() => '?').join(',');
    const edgeResult = this.db.exec(
      `${GRAPH_EDGE_QUERY} WHERE source_symbol_id IN (${placeholders}) AND target_symbol_id IN (${placeholders})`,
      [...nodeIds, ...nodeIds]
    );

    const edges = (edgeResult[0]?.values ?? []).map(rowToGraphEdge);

    return { nodes, edges, rootIds: nodeIds };
  }

  getAllEdges(): Array<{ sourceId: number; targetId: number }> {
    if (!this.db) return [];
    const result = this.db.exec('SELECT source_symbol_id, target_symbol_id FROM edges');
    return (result[0]?.values ?? []).map((row: unknown[]) => ({
      sourceId: row[0] as number,
      targetId: row[1] as number,
    }));
  }

  insertEdges(edges: Array<{ sourceId: number; targetId: number; kind: string; callLine?: number; callText?: string }>): void {
    if (!this.db || edges.length === 0) return;
    for (const edge of edges) {
      this.db.run(
        'INSERT OR IGNORE INTO edges (source_symbol_id, target_symbol_id, kind, call_line, call_text) VALUES (?, ?, ?, ?, ?)',
        [edge.sourceId, edge.targetId, edge.kind, edge.callLine ?? null, edge.callText ?? '']
      );
    }
  }

  deleteEdgesForFile(fileId: number): void {
    if (!this.db) return;
    this.db.run(
      'DELETE FROM edges WHERE source_symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)',
      [fileId]
    );
  }

  insertMetrics(symbolId: number, metrics: { cyclomatic: number; cognitive: number; paramCount: number; maxLoopDepth: number }): void {
    if (!this.db) return;
    this.db.run(
      'INSERT OR REPLACE INTO metrics (symbol_id, cyclomatic_complexity, cognitive_complexity, parameter_count, max_loop_depth) VALUES (?, ?, ?, ?, ?)',
      [symbolId, metrics.cyclomatic, metrics.cognitive, metrics.paramCount, metrics.maxLoopDepth]
    );
  }

  getSymbolsByFileId(fileId: number): SymbolRow[] {
    if (!this.db) return [];
    const result = this.db.exec(
      'SELECT id, name, kind, file_id, start_line, end_line, loc, parent_symbol_id FROM symbols WHERE file_id = ?',
      [fileId]
    );
    return (result[0]?.values ?? []).map((row: unknown[]) => ({
      id: row[0] as number,
      name: row[1] as string,
      kind: row[2] as string,
      fileId: row[3] as number,
      startLine: row[4] as number,
      endLine: row[5] as number,
      loc: row[6] as number,
      parentSymbolId: row[7] as number | null,
    }));
  }

  lookupSymbolsByName(name: string): Array<{ id: number; fileId: number; kind: string }> {
    if (!this.db) return [];
    const result = this.db.exec(
      'SELECT id, file_id, kind FROM symbols WHERE name = ?',
      [name]
    );
    return (result[0]?.values ?? []).map((row: unknown[]) => ({
      id: row[0] as number,
      fileId: row[1] as number,
      kind: row[2] as string,
    }));
  }

  getGraphData(rootIds?: number[]): GraphData {
    if (!this.db) return { nodes: [], edges: [], rootIds: [] };

    let nodeIds: number[];

    if (rootIds && rootIds.length > 0) {
      // Return the root nodes + their direct callees
      const placeholders = rootIds.map(() => '?').join(',');
      const calleeResult = this.db.exec(
        `SELECT DISTINCT target_symbol_id FROM edges WHERE source_symbol_id IN (${placeholders}) AND kind = 'call'`,
        rootIds
      );
      const calleeIds = (calleeResult[0]?.values ?? []).map((r: unknown[]) => r[0] as number);
      nodeIds = [...new Set([...rootIds, ...calleeIds])];
    } else {
      // Entry points: symbols with no incoming call edges (top-level functions)
      const entryResult = this.db.exec(
        `SELECT DISTINCT s.id FROM symbols s
         LEFT JOIN edges e ON s.id = e.target_symbol_id AND e.kind = 'call'
         WHERE e.id IS NULL AND s.kind IN ('function', 'method')
         LIMIT 100`
      );
      nodeIds = (entryResult[0]?.values ?? []).map((r: unknown[]) => r[0] as number);

      // Also grab their direct callees for an interesting first view
      if (nodeIds.length > 0) {
        const placeholders = nodeIds.map(() => '?').join(',');
        const calleeResult = this.db.exec(
          `SELECT DISTINCT target_symbol_id FROM edges WHERE source_symbol_id IN (${placeholders}) AND kind = 'call'`,
          nodeIds
        );
        const calleeIds = (calleeResult[0]?.values ?? []).map((r: unknown[]) => r[0] as number);
        nodeIds = [...new Set([...nodeIds, ...calleeIds])];
      }
    }

    if (nodeIds.length === 0) {
      // Fallback: just show all functions if no edges were extracted yet
      const fallback = this.db.exec(
        `SELECT s.id FROM symbols s WHERE s.kind IN ('function','method') LIMIT 80`
      );
      nodeIds = (fallback[0]?.values ?? []).map((r: unknown[]) => r[0] as number);
    }

    if (nodeIds.length === 0) return { nodes: [], edges: [], rootIds: [] };

    const placeholders = nodeIds.map(() => '?').join(',');

    const nodeResult = this.db.exec(
      `${GRAPH_NODE_QUERY} WHERE s.id IN (${placeholders})`,
      nodeIds
    );

    const nodes = (nodeResult[0]?.values ?? []).map(rowToGraphNode);

    const edgeResult = this.db.exec(
      `${GRAPH_EDGE_QUERY} WHERE source_symbol_id IN (${placeholders}) AND target_symbol_id IN (${placeholders})`,
      [...nodeIds, ...nodeIds]
    );

    const edges = (edgeResult[0]?.values ?? []).map(rowToGraphEdge);

    const resolvedRootIds = rootIds ?? nodes.map(n => n.id).slice(0, 20);

    return { nodes, edges, rootIds: resolvedRootIds };
  }

  getAllFilesAndSymbols(): { files: FileRow[]; symbols: SymbolRow[] } {
    if (!this.db) return { files: [], symbols: [] };

    const filesResult = this.db.exec('SELECT id, path, language, loc FROM files ORDER BY path');
    const files: FileRow[] = (filesResult[0]?.values ?? []).map((row: unknown[]) => ({
      id: row[0] as number,
      path: row[1] as string,
      language: row[2] as string | null,
      loc: row[3] as number,
    }));

    const symbolsResult = this.db.exec(
      'SELECT id, name, kind, file_id, start_line, end_line, loc, parent_symbol_id FROM symbols ORDER BY file_id, start_line'
    );
    const symbols: SymbolRow[] = (symbolsResult[0]?.values ?? []).map((row: unknown[]) => ({
      id: row[0] as number,
      name: row[1] as string,
      kind: row[2] as string,
      fileId: row[3] as number,
      startLine: row[4] as number,
      endLine: row[5] as number,
      loc: row[6] as number,
      parentSymbolId: row[7] as number | null,
    }));

    return { files, symbols };
  }

  getSymbolInfo(symbolId: number): { name: string; filePath: string; startLine: number; endLine: number; language: string; fileHash: string } | null {
    if (!this.db) return null;
    const result = this.db.exec(
      'SELECT s.name, f.path, s.start_line, s.end_line, f.language, f.hash FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.id = ?',
      [symbolId]
    );
    if (!result[0]?.values[0]) return null;
    const row = result[0].values[0];
    return {
      name: row[0] as string,
      filePath: row[1] as string,
      startLine: row[2] as number,
      endLine: row[3] as number,
      language: (row[4] as string | null) ?? 'unknown',
      fileHash: row[5] as string,
    };
  }

  getEntryPointIds(): number[] {
    if (!this.db) return [];
    const result = this.db.exec(
      `SELECT DISTINCT s.id FROM symbols s
       LEFT JOIN edges e ON s.id = e.target_symbol_id AND e.kind = 'call'
       WHERE e.id IS NULL AND s.kind IN ('function', 'method')`
    );
    return (result[0]?.values ?? []).map((r: unknown[]) => r[0] as number);
  }

  getAllFunctionIds(): number[] {
    if (!this.db) return [];
    const result = this.db.exec(`SELECT id FROM symbols WHERE kind IN ('function', 'method')`);
    return (result[0]?.values ?? []).map((r: unknown[]) => r[0] as number);
  }

  getSymbolFilePaths(): Map<number, string> {
    if (!this.db) return new Map();
    const result = this.db.exec(
      `SELECT s.id, f.path FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.kind IN ('function', 'method')`
    );
    const map = new Map<number, string>();
    for (const row of result[0]?.values ?? []) {
      map.set(row[0] as number, row[1] as string);
    }
    return map;
  }

  getProjectCoverage(): ProjectCoverage {
    const edges = this.getAllEdges();
    const allIds = this.getAllFunctionIds();
    const entryIds = this.getEntryPointIds();
    return computeReachability(edges, allIds, entryIds);
  }

  getStructuralMetrics(): Map<number, SymbolStructure> {
    // Cache: recomputing is O(V*(V+E)), so reuse until DB changes
    const mtime = this.readOnly ? this.lastMtime : Date.now();
    if (this.metricsCache && this.metricsCache.mtime === mtime) return this.metricsCache.data;

    const edges = this.getAllEdges();
    const allIds = this.getAllFunctionIds();
    const entryIds = this.getEntryPointIds();
    const filePaths = this.getSymbolFilePaths();
    const data = computeStructuralMetrics(edges, allIds, entryIds, filePaths, this.workspacePath);
    this.metricsCache = { mtime, data };
    return data;
  }

  getSymbolById(symbolId: number): GraphNode | null {
    if (!this.db) return null;
    const result = this.db.exec(`${GRAPH_NODE_QUERY} WHERE s.id = ?`, [symbolId]);
    if (!result[0]?.values[0]) return null;
    return rowToGraphNode(result[0].values[0]);
  }

  getCallers(symbolId: number): Array<GraphNode & { callLine?: number; callText?: string }> {
    if (!this.db) return [];
    const result = this.db.exec(
      `SELECT s.id, s.name, s.kind, f.path, s.start_line, s.end_line, s.loc, f.language,
              m.cyclomatic_complexity, m.cognitive_complexity, m.parameter_count, m.max_loop_depth,
              gc.commit_count, gc.recent_commit_count, e.call_line, e.call_text
       FROM edges e
       JOIN symbols s ON s.id = e.source_symbol_id
       JOIN files f ON s.file_id = f.id
       LEFT JOIN metrics m ON s.id = m.symbol_id
       LEFT JOIN git_churn gc ON f.id = gc.file_id
       WHERE e.target_symbol_id = ? AND e.kind = 'call'`,
      [symbolId]
    );
    return (result[0]?.values ?? []).map((row: unknown[]) => ({
      ...rowToGraphNode(row),
      callLine: (row[14] as number | null) ?? undefined,
      callText: (row[15] as string) || undefined,
    }));
  }

  getCallees(symbolId: number): Array<GraphNode & { callLine?: number; callText?: string }> {
    if (!this.db) return [];
    const result = this.db.exec(
      `SELECT s.id, s.name, s.kind, f.path, s.start_line, s.end_line, s.loc, f.language,
              m.cyclomatic_complexity, m.cognitive_complexity, m.parameter_count, m.max_loop_depth,
              gc.commit_count, gc.recent_commit_count, e.call_line, e.call_text
       FROM edges e
       JOIN symbols s ON s.id = e.target_symbol_id
       JOIN files f ON s.file_id = f.id
       LEFT JOIN metrics m ON s.id = m.symbol_id
       LEFT JOIN git_churn gc ON f.id = gc.file_id
       WHERE e.source_symbol_id = ? AND e.kind = 'call'`,
      [symbolId]
    );
    return (result[0]?.values ?? []).map((row: unknown[]) => ({
      ...rowToGraphNode(row),
      callLine: (row[14] as number | null) ?? undefined,
      callText: (row[15] as string) || undefined,
    }));
  }

  getAnnotations(opts?: { symbolId?: number; targetType?: string; targetName?: string }): AnnotationRow[] {
    if (!this.db) return [];
    let sql = 'SELECT id, symbol_id, target_type, target_name, tags, label, explanation, author, algorithmic_complexity, spatial_complexity, pitfalls, created_at, updated_at FROM annotations';
    const params: unknown[] = [];

    if (opts?.symbolId !== undefined) {
      sql += ' WHERE symbol_id = ?';
      params.push(opts.symbolId);
    } else if (opts?.targetType) {
      sql += ' WHERE target_type = ?';
      params.push(opts.targetType);
      if (opts.targetName) { sql += ' AND target_name = ?'; params.push(opts.targetName); }
    }

    const result = this.db.exec(sql, params);
    return (result[0]?.values ?? []).map(rowToAnnotation);
  }

  upsertAnnotation(data: {
    symbolId?: number | null;
    targetType?: 'symbol' | 'module' | 'project';
    targetName?: string;
    tags: string[]; label: string; explanation: string; author?: string;
    algorithmicComplexity?: string; spatialComplexity?: string; pitfalls?: string[];
  }): AnnotationRow {
    if (!this.db) throw new Error('Database not open');
    const now = Date.now();
    const tagsJson = JSON.stringify(data.tags);
    const pitfallsJson = JSON.stringify(data.pitfalls ?? []);
    const author = data.author ?? 'agent';
    const algComplexity = data.algorithmicComplexity ?? '';
    const spatComplexity = data.spatialComplexity ?? '';
    const targetType = data.targetType ?? 'symbol';
    const targetName = data.targetName ?? '';

    // Find existing: by symbolId for symbols, by targetType+targetName for modules/project
    let existing: any[] = [];
    if (data.symbolId) {
      const r = this.db.exec('SELECT id FROM annotations WHERE symbol_id = ?', [data.symbolId]);
      existing = r[0]?.values ?? [];
    } else if (targetName) {
      const r = this.db.exec('SELECT id FROM annotations WHERE target_type = ? AND target_name = ?', [targetType, targetName]);
      existing = r[0]?.values ?? [];
    }

    if (existing.length > 0) {
      const id = existing[0][0] as number;
      this.db.run(
        'UPDATE annotations SET tags = ?, label = ?, explanation = ?, author = ?, algorithmic_complexity = ?, spatial_complexity = ?, pitfalls = ?, updated_at = ? WHERE id = ?',
        [tagsJson, data.label, data.explanation, author, algComplexity, spatComplexity, pitfallsJson, now, id]
      );
    } else {
      this.db.run(
        'INSERT INTO annotations (symbol_id, target_type, target_name, tags, label, explanation, author, algorithmic_complexity, spatial_complexity, pitfalls, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [data.symbolId ?? null, targetType, targetName, tagsJson, data.label, data.explanation, author, algComplexity, spatComplexity, pitfallsJson, now, now]
      );
    }

    this.save();
    if (data.symbolId) return this.getAnnotations({ symbolId: data.symbolId })[0];
    return this.getAnnotations({ targetType, targetName })[0];
  }

  savePerf(perf: { timestamp: number; totalFiles: number; changedFiles: number; totalMs: number; phases: Array<{ name: string; ms: number }>; skipped: boolean }): void {
    if (!this.db) return;
    this.db.run(
      'INSERT INTO perf_history (timestamp, total_files, changed_files, total_ms, phases, skipped) VALUES (?, ?, ?, ?, ?, ?)',
      [perf.timestamp, perf.totalFiles, perf.changedFiles, perf.totalMs, JSON.stringify(perf.phases), perf.skipped ? 1 : 0]
    );
    this.save();
  }

  getPerfHistory(limit = 10): Array<{ timestamp: number; totalFiles: number; changedFiles: number; totalMs: number; phases: Array<{ name: string; ms: number }>; skipped: boolean }> {
    if (!this.db) return [];
    const result = this.db.exec(`SELECT timestamp, total_files, changed_files, total_ms, phases, skipped FROM perf_history ORDER BY timestamp DESC LIMIT ?`, [limit]);
    return (result[0]?.values ?? []).map((row: unknown[]) => ({
      timestamp: row[0] as number,
      totalFiles: row[1] as number,
      changedFiles: row[2] as number,
      totalMs: row[3] as number,
      phases: JSON.parse((row[4] as string) || '[]'),
      skipped: (row[5] as number) === 1,
    }));
  }

  clear(): void {
    if (!this.db) return;
    this.metricsCache = undefined;
    this.db.run('DELETE FROM annotations');
    this.db.run('DELETE FROM metrics');
    this.db.run('DELETE FROM edges');
    this.db.run('DELETE FROM git_churn');
    this.db.run('DELETE FROM symbols');
    this.db.run('DELETE FROM files');
    this.save();
  }

  /** Remove annotations that reference deleted symbols (foreign key cascade fallback). */
  cleanOrphanAnnotations(): number {
    if (!this.db) return 0;
    this.db.run('DELETE FROM annotations WHERE symbol_id NOT IN (SELECT id FROM symbols)');
    const result = this.db.exec('SELECT changes()');
    const count = (result[0]?.values[0]?.[0] as number) ?? 0;
    if (count > 0) this.save();
    return count;
  }

  persist(): void {
    this.metricsCache = undefined;
    this.save();
  }
}

export interface FileRow {
  id: number;
  path: string;
  language: string | null;
  loc: number;
}

function rowToAnnotation(row: unknown[]): AnnotationRow {
  return {
    id: row[0] as number,
    symbolId: (row[1] as number | null),
    targetType: (row[2] as string) as AnnotationRow['targetType'],
    targetName: (row[3] as string) || '',
    tags: JSON.parse((row[4] as string) || '[]'),
    label: row[5] as string,
    explanation: row[6] as string,
    author: row[7] as string,
    algorithmicComplexity: (row[8] as string) || '',
    spatialComplexity: (row[9] as string) || '',
    pitfalls: JSON.parse((row[10] as string) || '[]'),
    createdAt: row[11] as number,
    updatedAt: row[12] as number,
  };
}

export interface AnnotationRow {
  id: number;
  symbolId: number | null;
  targetType: 'symbol' | 'module' | 'project';
  targetName: string;
  tags: string[];
  label: string;
  explanation: string;
  author: string;
  algorithmicComplexity: string;
  spatialComplexity: string;
  pitfalls: string[];
  createdAt: number;
  updatedAt: number;
}

export interface SymbolRow {
  id: number;
  name: string;
  kind: string;
  fileId: number;
  startLine: number;
  endLine: number;
  loc: number;
  parentSymbolId: number | null;
}

function rowToGraphNode(row: unknown[]): GraphNode {
  return {
    id: row[0] as number,
    name: row[1] as string,
    kind: row[2] as string,
    filePath: row[3] as string,
    line: row[4] as number,
    endLine: row[5] as number,
    loc: row[6] as number,
    language: (row[7] as string | null) ?? 'unknown',
    complexity: (row[8] as number | null) ?? undefined,
    cognitiveComplexity: (row[9] as number | null) ?? undefined,
    parameterCount: (row[10] as number | null) ?? undefined,
    maxLoopDepth: (row[11] as number | null) ?? undefined,
    churnCount: (row[12] as number | null) ?? undefined,
    recentChurnCount: (row[13] as number | null) ?? undefined,
  };
}

function rowToGraphEdge(row: unknown[]): GraphEdge {
  return {
    sourceId: row[0] as number,
    targetId: row[1] as number,
    kind: row[2] as GraphEdge['kind'],
    isCycle: (row[3] as number) === 1,
  };
}

const DEFAULT_IGNORE = `# IVE ignore patterns
# One directory or glob pattern per line. Lines starting with # are comments.
# This file controls which paths IVE skips during indexing.
# Common heavy directories are excluded by default (node_modules, .venv, etc.)
#
# Examples:
# data/
# *.generated.ts
# test/fixtures/
`;

function initIveDir(iveDir: string): void {
  if (!fs.existsSync(iveDir)) {
    fs.mkdirSync(iveDir, { recursive: true });
  }

  const ignorePath = path.join(iveDir, 'ignore');
  if (!fs.existsSync(ignorePath)) {
    fs.writeFileSync(ignorePath, DEFAULT_IGNORE, 'utf-8');
  }

  const workspaceDir = path.dirname(iveDir);
  const gitignorePath = path.join(workspaceDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('.ive')) {
      fs.appendFileSync(gitignorePath, '\n# IVE local index\n.ive/\n');
    }
  }
}

