import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { IVEPanelProvider } from './webview/IVEPanelProvider.js';
import { IndexManager } from './indexer/IndexManager.js';

let indexManager: IndexManager | undefined;

export function activate(context: vscode.ExtensionContext) {
  indexManager = new IndexManager(context);
  const provider = new IVEPanelProvider(context, indexManager);

  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (ws) registerMcpServer(ws, context.extensionUri.fsPath);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ive.graphView', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ive.reindex', async () => {
      await indexManager?.indexWorkspace();
      const data = indexManager?.getGraphData();
      if (data) {
        provider.sendGraphData(data);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ive.showDiff', () => {
      provider.showDiff();
    })
  );

  // ── Viewer command IPC: watch .ive/viewer-cmd.json from MCP server ──────
  if (ws) {
    const cmdPattern = new vscode.RelativePattern(ws, '.ive/viewer-cmd.json');
    const cmdWatcher = vscode.workspace.createFileSystemWatcher(cmdPattern);

    const processViewerCommand = () => {
      const cmdPath = path.join(ws, '.ive', 'viewer-cmd.json');
      try {
        if (!fs.existsSync(cmdPath)) return;
        const raw = fs.readFileSync(cmdPath, 'utf-8');
        fs.unlinkSync(cmdPath);
        const cmd = JSON.parse(raw);
        if (cmd.action === 'highlight' && Array.isArray(cmd.payload?.nodeIds)) {
          provider.highlightNodes(cmd.payload.nodeIds);
        }
      } catch { /* ignore malformed or race conditions */ }
    };

    cmdWatcher.onDidCreate(processViewerCommand);
    cmdWatcher.onDidChange(processViewerCommand);
    context.subscriptions.push(cmdWatcher);

    // Process any command written before extension activated
    processViewerCommand();
  }

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (indexManager) {
        await indexManager.indexFile(doc.uri);
        const data = indexManager.getGraphData();
        if (data) {
          provider.sendGraphData(data);
        }
      }
    })
  );
}

export function deactivate() {
  indexManager?.dispose();
}

function registerMcpServer(workspacePath: string, extensionPath: string): void {
  const serverPath = path.join(extensionPath, 'dist', 'mcp-server.js');
  if (!fs.existsSync(serverPath)) return;

  const claudeConfigPath = path.join(os.homedir(), '.claude.json');
  try {
    let config: any = {};
    if (fs.existsSync(claudeConfigPath)) {
      config = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf-8'));
    }

    const projectKey = workspacePath.replace(/\\/g, '/');
    if (!config.projects) config.projects = {};
    if (!config.projects[projectKey]) config.projects[projectKey] = {};
    if (!config.projects[projectKey].mcpServers) config.projects[projectKey].mcpServers = {};
    if (config.projects[projectKey].mcpServers.ive) return;

    config.projects[projectKey].mcpServers.ive = {
      command: 'node',
      args: [serverPath, '--workspace', workspacePath],
    };

    fs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2) + '\n');
  } catch {
    // Non-critical
  }
}
