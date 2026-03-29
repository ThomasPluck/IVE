import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IndexManager } from '../indexer/IndexManager.js';
import { getDiffSummary } from '../indexer/diffAnalyzer.js';
import type { GraphData, DashboardData, NodeDetailData, WebviewToExtensionMessage, ExtensionToWebviewMessage } from '../types.js';
import type { DiffSummary } from '../indexer/diffAnalyzer.js';
import { detectModuleBoundaries } from '../indexer/graphAnalyzer.js';

export class IVEPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private drillStack: number[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly indexManager: IndexManager
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
      ],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => this.handleMessage(message),
      undefined,
      this.context.subscriptions
    );
  }

  sendGraphData(data: GraphData): void {
    this.drillStack = [];
    this.postMessage({ type: 'graphData', data });
  }

  showDiff(): void {
    const workspacePath = this.indexManager.getWorkspacePath();
    if (!workspacePath) return;

    const graphData = this.indexManager.getGraphData();
    if (!graphData) {
      vscode.window.showInformationMessage('IVE: No graph data — index the workspace first.');
      return;
    }

    const diff = getDiffSummary(workspacePath);
    if (diff.modifiedFiles.length === 0) {
      vscode.window.showInformationMessage('IVE: No uncommitted changes found.');
      return;
    }

    this.postMessage({ type: 'diffData', data: annotateDiffStatus(graphData, diff) });
  }

  // ── Message dispatch ─────────────────────────────────────────────────────

  private handleMessage(message: WebviewToExtensionMessage): void {
    switch (message.type) {
      case 'ready':        return this.onWebviewReady();
      case 'navigate':     return this.navigateToSource(message.filePath, message.line);
      case 'drillDown':    return this.onDrillDown(message.symbolId);
      case 'drillUp':      return this.onDrillUp();
      case 'search':       return this.onSearch(message.query);
      case 'getCoverage':  return this.onGetCoverage();
      case 'showDeadCode': return this.onShowDeadCode();
      case 'getDiff':      return this.onGetDiff();
      case 'selectNode':   return this.onSelectNode(message.symbolId);
    }
  }

  // ── Message handlers ─────────────────────────────────────────────────────

  private onDrillDown(symbolId: number): void {
    this.drillStack.push(symbolId);
    this.postMessage({ type: 'graphData', data: this.indexManager.getGraphDataForSymbol(symbolId) });
  }

  private onDrillUp(): void {
    this.drillStack.pop();
    const parentId = this.drillStack[this.drillStack.length - 1];
    const data = parentId !== undefined
      ? this.indexManager.getGraphDataForSymbol(parentId)
      : this.indexManager.getGraphData() ?? { nodes: [], edges: [], rootIds: [] };
    this.postMessage({ type: 'graphData', data });
  }

  private onSearch(query: string): void {
    if (query.trim()) {
      this.postMessage({ type: 'graphData', data: this.indexManager.searchSymbols(query) });
    } else {
      const full = this.indexManager.getGraphData();
      if (full) this.postMessage({ type: 'graphData', data: full });
    }
  }

  private onGetCoverage(): void {
    const db = this.indexManager.getDatabase();
    if (db) this.postMessage({ type: 'coverageData', data: db.getProjectCoverage() });
  }

  private onSelectNode(symbolId: number): void {
    const db = this.indexManager.getDatabase();
    if (!db) return;
    const node = db.getSymbolById(symbolId);
    if (!node) return;
    const callers = db.getCallers(symbolId);
    const callees = db.getCallees(symbolId);
    const annotations = db.getAnnotations({ symbolId }).map(a => ({
      tags: a.tags, label: a.label, explanation: a.explanation,
      algorithmicComplexity: a.algorithmicComplexity, spatialComplexity: a.spatialComplexity, pitfalls: a.pitfalls,
    }));
    this.postMessage({ type: 'nodeDetail', data: { node, callers, callees, annotations } });
  }

  private sendDashboard(): void {
    const db = this.indexManager.getDatabase();
    if (!db) return;

    const coverage = db.getProjectCoverage();
    const allAnnotations = db.getAnnotations();
    const annotationCount = allAnnotations.filter(a => a.targetType === 'symbol').length;

    // Architecture check
    const archAnnotations = allAnnotations.filter(a => a.targetType === 'module' && a.tags.includes('architecture'));
    const rules = new Map<string, string[]>();
    for (const a of archAnnotations) {
      try { rules.set(a.targetName, JSON.parse(a.explanation)); } catch { /* skip */ }
    }

    let archViolations = 0;
    let archCompliant = 0;
    if (rules.size > 0) {
      const edges = db.getAllEdges();
      const metrics = db.getStructuralMetrics();
      const moduleMap = new Map<number, string>();
      for (const [id, m] of metrics) moduleMap.set(id, m.module);
      const boundaries = detectModuleBoundaries(edges, moduleMap);
      for (const b of boundaries) {
        const allowed = rules.get(b.sourceModule);
        if (!allowed) continue;
        if (allowed.includes(b.targetModule)) archCompliant++;
        else archViolations++;
      }
    }

    // Risks
    const metricsMap = db.getStructuralMetrics();
    const annotatedIds = new Set(allAnnotations.filter(a => a.symbolId != null).map(a => a.symbolId));
    const risks: DashboardData['risks'] = [];
    for (const [id, m] of metricsMap) {
      if (m.coupling < 10 && m.impactRadius < 20) continue;
      if (annotatedIds.has(id)) continue;
      const n = db.getSymbolById(id);
      if (!n) continue;
      risks.push({ id, name: n.name, coupling: m.coupling, impact: m.impactRadius, cc: n.complexity ?? 0, file: n.filePath });
    }
    risks.sort((a, b) => b.coupling - a.coupling);

    // Perf
    const perfRuns = db.getPerfHistory(1);
    const lastPerf = perfRuns.length > 0
      ? { totalMs: perfRuns[0].totalMs, changedFiles: perfRuns[0].changedFiles, totalFiles: perfRuns[0].totalFiles, skipped: perfRuns[0].skipped }
      : null;

    this.postMessage({
      type: 'dashboard',
      data: {
        coverage,
        annotationCount,
        unannotatedNodes: db.getUnannotatedSymbolCount(),
        unannotatedEdges: db.getUnannotatedEdgeCount(),
        testCoverage: db.getTestCoverageStats(),
        architectureStatus: { pass: archViolations === 0, violations: archViolations, compliant: archCompliant },
        lastPerf,
        risks: risks.slice(0, 15),
      },
    });
  }

  private onShowDeadCode(): void {
    const graphData = this.indexManager.getGraphData();
    if (!graphData) return;
    this.postMessage({ type: 'graphData', data: this.enrichWithStructuralMetrics(graphData) });
  }

  private onGetDiff(): void {
    const workspacePath = this.indexManager.getWorkspacePath();
    if (!workspacePath) return;
    const graphData = this.indexManager.getGraphData();
    if (!graphData) return;
    const diff = getDiffSummary(workspacePath);
    this.postMessage({ type: 'diffData', data: annotateDiffStatus(graphData, diff) });
  }

  // ── Shared helpers ───────────────────────────────────────────────────────

  private enrichWithStructuralMetrics(graphData: GraphData): GraphData {
    const db = this.indexManager.getDatabase();
    if (!db) return graphData;
    const metrics = db.getStructuralMetrics();
    return {
      ...graphData,
      nodes: graphData.nodes.map(node => {
        const m = metrics.get(node.id);
        if (!m) return node;
        return { ...node, isDeadCode: m.isDeadCode, fanIn: m.fanIn, fanOut: m.fanOut, coupling: m.coupling, depthFromEntry: m.depthFromEntry, impactRadius: m.impactRadius, module: m.module };
      }),
    };
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    this.view?.webview.postMessage(message);
  }

  private onWebviewReady(): void {
    console.log('IVE: Webview ready, starting indexing...');
    this.indexManager.indexWorkspace().then(() => {
      const data = this.indexManager.getGraphData();
      if (data) {
        const enriched = this.enrichWithStructuralMetrics(data);
        console.log(`IVE: Sending graph data — ${enriched.nodes.length} nodes, ${enriched.edges.length} edges`);
        this.postMessage({ type: 'graphData', data: enriched });
        this.sendDashboard();
      } else {
        console.log('IVE: No graph data after indexing');
      }
    });
  }

  private navigateToSource(filePath: string, line: number): void {
    vscode.window.showTextDocument(vscode.Uri.file(filePath), {
      selection: new vscode.Range(
        new vscode.Position(Math.max(0, line - 1), 0),
        new vscode.Position(Math.max(0, line - 1), 0)
      ),
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    }).then(undefined, () => {
      vscode.window.showErrorMessage(`IVE: Could not open file ${filePath}`);
    });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const distPath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');

    const indexHtmlPath = path.join(distPath.fsPath, 'index.html');
    if (!fs.existsSync(indexHtmlPath)) {
      return `<html><body><h3>IVE: Webview not built. Run "npm run build".</h3></body></html>`;
    }

    let html = fs.readFileSync(indexHtmlPath, 'utf-8');
    const nonce = getNonce();

    html = html.replace(/(href|src)="\.?\/?assets\//g, (match, attr) => {
      const assetsUri = webview.asWebviewUri(vscode.Uri.joinPath(distPath, 'assets'));
      return `${attr}="${assetsUri}/`;
    });

    html = html.replace(/ crossorigin/g, '');

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} https:`,
      `font-src ${webview.cspSource}`,
    ].join('; ') + ';';

    html = html.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
    html = html.replace(/<script /g, `<script nonce="${nonce}" `);

    return html;
  }
}

function annotateDiffStatus(graphData: GraphData, diff: DiffSummary): GraphData {
  const modifiedFileSet = new Set(diff.modifiedFiles);
  return {
    ...graphData,
    nodes: graphData.nodes.map(node => {
      if (!modifiedFileSet.has(node.filePath)) return node;
      const addedLines = diff.addedLines.get(node.filePath) ?? [];
      const hasOverlap = addedLines.some(l => l >= node.line && l <= node.endLine);
      return { ...node, diffStatus: hasOverlap ? 'modified' as const : undefined };
    }),
  };
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
