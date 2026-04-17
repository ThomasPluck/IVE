// Webview panel provider: hosts the React app and relays messages between
// daemon and the view.

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  DaemonEvent,
  FromExtensionMessage,
  FromWebviewMessage,
  HealthScore,
  Location,
  MethodName,
  MethodRequest,
  MethodResponse,
} from "./contracts";
import type { Daemon } from "./daemon";
import * as log from "./logger";

export class IvePanel implements vscode.WebviewViewProvider {
  public static readonly viewType = "ive.panel";
  private view: vscode.WebviewView | null = null;
  private readyPromise!: Promise<void>;
  private resolveReady!: () => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly daemon: Daemon,
  ) {
    this.readyPromise = new Promise((r) => (this.resolveReady = r));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
    };
    view.webview.html = this.renderHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: FromWebviewMessage) => this.onMessage(msg));
  }

  async whenReady(): Promise<void> {
    return this.readyPromise;
  }

  post(msg: FromExtensionMessage): void {
    this.view?.webview.postMessage(msg);
  }

  broadcastDaemonEvent(event: DaemonEvent): void {
    this.post({ type: "event", payload: event });
  }

  async refreshWorkspaceState(): Promise<void> {
    try {
      const [scores, capabilities, notes] = await Promise.all([
        this.daemon.call("workspace.healthSummary"),
        this.daemon.call("capabilities.status"),
        this.daemon.call("notes.list"),
      ]);
      const diagnostics: Record<string, MethodResponse<"file.diagnostics">> = {};
      const files = await this.daemon.call("file.list");
      for (const f of files) {
        diagnostics[f.file] = await this.daemon.call("file.diagnostics", { file: f.file });
      }
      this.post({
        type: "workspaceState",
        payload: {
          scores: scores as HealthScore[],
          diagnostics,
          capabilities: capabilities as Record<string, { available: boolean; reason: string }>,
          notes: notes as import("./contracts").Note[],
        },
      });
    } catch (e) {
      log.error("refreshWorkspaceState failed", (e as Error).message ?? e);
    }
  }

  private async onMessage(msg: FromWebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.resolveReady();
        break;
      case "rpc":
        try {
          const result = await this.daemon.call(
            msg.method as MethodName,
            msg.params as MethodRequest<MethodName>,
          );
          this.post({ type: "rpcResult", id: msg.id, result });
        } catch (e) {
          const err = e as { code?: number; message?: string };
          this.post({
            type: "rpcError",
            id: msg.id,
            error: { code: err.code ?? -32000, message: err.message ?? "unknown" },
          });
        }
        break;
      case "openFile":
        openAtLocation(msg.location.file, msg.location.range.start[0], msg.location.range.start[1]);
        break;
      case "summarize":
        try {
          const summary = await this.daemon.call("summary.generate", {
            symbol: msg.symbol,
            depth: "body",
          });
          this.post({ type: "rpcResult", id: -1, result: summary });
        } catch (e) {
          log.warn("summarize failed", (e as Error).message ?? e);
        }
        break;
      case "sliceRequested":
        try {
          const slice = await this.daemon.call("slice.compute", msg.request);
          this.post({ type: "rpcResult", id: -2, result: slice });
        } catch (e) {
          const err = e as { code?: number; message?: string };
          this.post({
            type: "rpcError",
            id: -2,
            error: { code: err.code ?? -32000, message: err.message ?? "slice failed" },
          });
        }
        break;
      case "applyFix":
        await this.applyFix(msg.fix);
        break;
      case "resolveNote":
        try {
          await this.daemon.call("notes.resolve", { id: msg.id });
        } catch (e) {
          log.warn("notes.resolve failed", (e as Error).message ?? e);
        }
        break;
    }
  }

  private async applyFix(fix: { description: string; edits: { location: Location; newText: string }[] }): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;
    const root = folders[0].uri;
    const wsEdit = new vscode.WorkspaceEdit();
    for (const edit of fix.edits) {
      const uri = vscode.Uri.joinPath(root, edit.location.file);
      const range = new vscode.Range(
        new vscode.Position(edit.location.range.start[0], edit.location.range.start[1]),
        new vscode.Position(edit.location.range.end[0], edit.location.range.end[1]),
      );
      wsEdit.replace(uri, range, edit.newText);
    }
    const applied = await vscode.workspace.applyEdit(wsEdit);
    if (!applied) {
      vscode.window.showWarningMessage(`IVE: fix "${fix.description}" could not be applied.`);
      return;
    }
    // Save the affected documents so the daemon's watcher picks the change up.
    const touched = new Set(fix.edits.map((e) => e.location.file));
    for (const rel of touched) {
      const uri = vscode.Uri.joinPath(root, rel);
      const doc = await vscode.workspace.openTextDocument(uri);
      await doc.save();
    }
    vscode.window.setStatusBarMessage(`IVE: applied fix — ${fix.description}`, 4000);
  }

  private renderHtml(webview: vscode.Webview): string {
    const webviewDir = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const htmlPath = path.join(webviewDir.fsPath, "index.html");
    let html = "";
    try {
      html = fs.readFileSync(htmlPath, "utf8");
    } catch {
      return fallbackHtml();
    }
    // Rewrite asset URIs to webview-safe form and inject CSP nonce.
    const nonce = crypto();
    html = html.replace(
      /(src|href)=\"(\/?[^"]+)\"/g,
      (_m, attr: string, p: string) => {
        if (p.startsWith("http") || p.startsWith("data:")) return `${attr}="${p}"`;
        const clean = p.startsWith("/") ? p.slice(1) : p;
        const uri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, clean));
        return `${attr}="${uri.toString()}"`;
      },
    );
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};`;
    html = html.replace(
      "<head>",
      `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`,
    );
    html = html.replace(/<script/g, `<script nonce="${nonce}"`);
    return html;
  }
}

function crypto(): string {
  let out = "";
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let i = 0; i < 24; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function openAtLocation(file: string, line: number, col: number): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return;
  const uri = vscode.Uri.joinPath(folders[0].uri, file);
  vscode.window.showTextDocument(uri).then((editor) => {
    const pos = new vscode.Position(line, col);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  });
}

function fallbackHtml(): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>IVE</title></head>
<body style="font-family: ui-monospace, monospace; padding: 16px; background: #0d1117; color: #c9d1d9;">
  <h3 style="margin-top: 0;">IVE webview not built</h3>
  <p>Run <code>cd webview &amp;&amp; npm install &amp;&amp; npm run build</code>, then reload VSCode.</p>
</body>
</html>`;
}
