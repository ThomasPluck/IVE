import * as vscode from "vscode";
import { Daemon, findDaemonBinary } from "./daemon";
import { IvePanel } from "./panel";
import { DiagnosticBridge } from "./diagnostics";
import { registerCommands } from "./commands";
import { HealthCodeLensProvider, buildDecorations } from "./codelens";
import type { HealthScore } from "./contracts";
import * as log from "./logger";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    log.warn("no workspace folder open; IVE stays idle");
    return;
  }
  const workspace = folders[0].uri.fsPath;

  const cfg = vscode.workspace.getConfiguration("ive");
  const userBin = cfg.get<string>("daemon.path") ?? "";
  const logLevel = cfg.get<string>("logLevel") ?? "info";

  const bin = findDaemonBinary(context.extensionPath, userBin);
  if (!bin) {
    vscode.window.showErrorMessage(
      "IVE: daemon binary not found. Build with `cargo build --release` or set `ive.daemon.path`.",
    );
    return;
  }

  const daemon = new Daemon({ binaryPath: bin, workspace, logLevel });
  context.subscriptions.push({ dispose: () => void daemon.stop() });

  const panel = new IvePanel(context.extensionUri, daemon);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(IvePanel.viewType, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const diagnosticBridge = new DiagnosticBridge(workspace, context);

  daemon.on("event", async (event) => {
    panel.broadcastDaemonEvent(event);
    switch (event.type) {
      case "diagnosticsUpdated":
        diagnosticBridge.set(event.file, event.diagnostics);
        break;
      case "indexProgress":
        if (event.filesDone === event.filesTotal) {
          panel.post({ type: "status", payload: { phase: "ready" } });
          panel.refreshWorkspaceState().catch(() => undefined);
        }
        break;
      case "capabilityDegraded":
        vscode.window.setStatusBarMessage(
          `IVE: ${event.capability} degraded — ${event.reason}`,
          8000,
        );
        break;
      case "capabilityRestored":
        break;
      case "healthUpdated":
        break;
    }
  });

  daemon.on("fatal", (err: Error) => {
    vscode.window.showErrorMessage(`IVE daemon fatal: ${err.message}`);
  });

  registerCommands(context, { daemon, panel });

  const codeLens = new HealthCodeLensProvider(daemon);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: "python", scheme: "file" },
        { language: "typescript", scheme: "file" },
        { language: "typescriptreact", scheme: "file" },
      ],
      codeLens,
    ),
  );

  const latestScores: { value: HealthScore[] } = { value: [] };
  const refreshEditorDecorations = () => {
    for (const editor of vscode.window.visibleTextEditors) {
      buildDecorations(editor, latestScores.value);
    }
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(refreshEditorDecorations),
    vscode.window.onDidChangeVisibleTextEditors(refreshEditorDecorations),
  );

  daemon.on("event", (event) => {
    if (event.type === "healthUpdated") {
      latestScores.value = event.scores;
      codeLens.refresh();
      refreshEditorDecorations();
    }
  });

  panel.post({ type: "status", payload: { phase: "cold" } });
  daemon.start();

  // Kick off the initial scan on next tick.
  queueMicrotask(async () => {
    try {
      await daemon.call("ping");
      panel.post({ type: "status", payload: { phase: "indexing" } });
      await daemon.call("workspace.scan");
      await panel.refreshWorkspaceState();
    } catch (e) {
      log.error("initial scan failed", (e as Error).message ?? e);
      panel.post({
        type: "status",
        payload: { phase: "error", message: (e as { message?: string }).message ?? "scan failed" },
      });
    }
  });
}

export function deactivate(): void {
  // subscriptions handle cleanup
}
