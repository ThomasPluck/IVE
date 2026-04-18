import * as vscode from "vscode";
import type { Daemon } from "./daemon";
import type { IvePanel } from "./panel";
import type { HealthScore, SliceDirection } from "./contracts";
import * as log from "./logger";

interface Context {
  daemon: Daemon;
  panel: IvePanel;
}

export function registerCommands(context: vscode.ExtensionContext, ctx: Context): void {
  const register = (id: string, fn: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  register("ive.show", () => {
    vscode.commands.executeCommand("workbench.view.extension.ive-explorer");
  });

  register("ive.sliceBackward", async () => requestSlice(ctx, "backward"));
  register("ive.sliceForward", async () => requestSlice(ctx, "forward"));

  register("ive.summarize", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("IVE: open a file and place the cursor on a function.");
      return;
    }
    const pos = editor.selection.active;
    try {
      const def = await ctx.daemon.call("symbol.definition", {
        location: {
          file: relPath(editor.document.uri),
          range: { start: [pos.line, pos.character], end: [pos.line, pos.character] },
        },
      });
      if (!def) {
        vscode.window.showInformationMessage("IVE: no symbol found at cursor.");
        return;
      }
      // Resolve to a symbol id by asking the daemon for the file's units via healthSummary and matching range.
      const list = (await ctx.daemon.call("workspace.healthSummary")) as HealthScore[];
      const match = list.find(
        (s) =>
          s.location.file === def.file &&
          s.location.range.start[0] === def.range.start[0] &&
          typeof s.target === "string",
      );
      if (!match || typeof match.target !== "string") {
        vscode.window.showInformationMessage("IVE: summary currently only supports function-level symbols.");
        return;
      }
      const summary = await ctx.daemon.call("summary.generate", {
        symbol: match.target,
        depth: "body",
      });
      const doc = await vscode.workspace.openTextDocument({
        content: summary.text,
        language: "markdown",
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (e) {
      log.error("summarize failed", (e as Error).message ?? e);
      vscode.window.showErrorMessage(`IVE summary: ${(e as { message?: string }).message ?? "failed"}`);
    }
  });

  register("ive.jumpToWorst", async () => {
    const scores = (await ctx.daemon.call("workspace.healthSummary")) as HealthScore[];
    const worst = [...scores].sort((a, b) => b.composite - a.composite)[0];
    if (!worst) {
      vscode.window.showInformationMessage("IVE: no files scored yet.");
      return;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;
    const uri = vscode.Uri.joinPath(folders[0].uri, worst.location.file);
    const editor = await vscode.window.showTextDocument(uri);
    const pos = new vscode.Position(worst.location.range.start[0], worst.location.range.start[1]);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  });

  register("ive.rescan", async () => {
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "IVE: rescanning…" },
      async () => {
        await ctx.daemon.call("cache.invalidate", {});
        await ctx.daemon.call("workspace.scan");
        await ctx.panel.refreshWorkspaceState();
      },
    );
  });

  register("ive.showLogs", () => {
    // Logger module owns the channel; this is a tiny shim.
    vscode.commands.executeCommand("workbench.action.output.toggleOutput");
  });

  register("ive.configure", async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;
    const cfg = vscode.Uri.joinPath(folders[0].uri, ".ive", "config.toml");
    try {
      await vscode.workspace.fs.stat(cfg);
    } catch {
      const defaultBody =
        "[health]\nnovelty = 0.2\ncognitive_complexity = 0.3\ncoupling = 0.2\nai_signal = 0.3\n\nignore = []\n";
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folders[0].uri, ".ive"));
      await vscode.workspace.fs.writeFile(cfg, new TextEncoder().encode(defaultBody));
    }
    const doc = await vscode.workspace.openTextDocument(cfg);
    await vscode.window.showTextDocument(doc);
  });
}

async function requestSlice(ctx: Context, direction: SliceDirection): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  try {
    await ctx.daemon.call("slice.compute", {
      origin: {
        file: relPath(editor.document.uri),
        range: {
          start: [editor.selection.active.line, editor.selection.active.character],
          end: [editor.selection.active.line, editor.selection.active.character],
        },
      },
      direction,
      kind: "thin",
      crossFile: true,
    });
    vscode.window.showInformationMessage("IVE: slicing not yet available (workstream C).");
  } catch (e) {
    const err = e as { message?: string };
    vscode.window.showInformationMessage(`IVE slice: ${err.message ?? "capability unavailable"}`);
  }
}

function relPath(uri: vscode.Uri): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return uri.fsPath;
  const base = folders[0].uri.fsPath;
  const p = uri.fsPath;
  if (p.startsWith(base)) {
    return p.slice(base.length + 1).split(/[\\/]/).join("/");
  }
  return p;
}
