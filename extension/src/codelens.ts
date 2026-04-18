// Per-function CodeLens above each function line, per spec §7.7:
//   `● composite 0.72 · cc 18 · coupling 9 | summarize | slice backward`
//
// The composite dot is bucket-coloured via inline HTML in hover markdown; the
// rest is a regular CodeLens title with command bindings.

import * as vscode from "vscode";
import type { Daemon } from "./daemon";
import type { HealthScore } from "./contracts";

const BUCKET_DOT: Record<string, string> = {
  green: "●",
  yellow: "●",
  red: "●",
};

export class HealthCodeLensProvider implements vscode.CodeLensProvider {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly daemon: Daemon) {}

  refresh(): void {
    this.emitter.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const rel = relPath(document.uri);
    if (!rel) return [];
    let scores: HealthScore[];
    try {
      scores = await this.daemon.call("workspace.healthSummary");
    } catch {
      return [];
    }
    return scores
      .filter((s) => typeof s.target === "string" && s.location.file === rel)
      .map((s) => {
        const line = s.location.range.start[0];
        const range = new vscode.Range(line, 0, line, 0);
        const dot = BUCKET_DOT[s.bucket] ?? "·";
        const title = `${dot} composite ${s.composite.toFixed(2)} · cc ${s.cognitiveComplexity.raw} · coupling ${s.coupling.fanIn + s.coupling.fanOut}`;
        return new vscode.CodeLens(range, {
          title,
          command: "ive.summarize",
          tooltip: bucketTooltip(s),
        });
      });
  }
}

function bucketTooltip(s: HealthScore): string {
  const pieces = [
    `bucket ${s.bucket}`,
    `composite ${s.composite.toFixed(2)}`,
    `novelty ${s.novelty.value.toFixed(2)} (churn ${s.novelty.recentChurnLoc} LOC)`,
    `complexity ${s.cognitiveComplexity.raw}`,
    `fan-in ${s.coupling.fanIn} · fan-out ${s.coupling.fanOut}`,
    `diagnostics ${s.aiSignal.diagnosticCount}`,
  ];
  return pieces.join(" · ");
}

function relPath(uri: vscode.Uri): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  const base = folders[0].uri.fsPath;
  const p = uri.fsPath;
  if (!p.startsWith(base)) return null;
  return p.slice(base.length + 1).split(/[\\/]/).join("/");
}

export function buildDecorations(
  editor: vscode.TextEditor,
  scores: HealthScore[],
): void {
  const redRanges: vscode.Range[] = [];
  const rel = relPath(editor.document.uri);
  if (!rel) return;
  for (const s of scores) {
    if (typeof s.target !== "string") continue;
    if (s.location.file !== rel) continue;
    if (s.composite <= 0.6) continue;
    redRanges.push(
      new vscode.Range(
        s.location.range.start[0],
        0,
        s.location.range.end[0],
        0,
      ),
    );
  }
  editor.setDecorations(redDecoration(), redRanges);
}

let _redDeco: vscode.TextEditorDecorationType | null = null;
function redDecoration(): vscode.TextEditorDecorationType {
  if (_redDeco) return _redDeco;
  _redDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: false,
    borderWidth: "0 0 0 2px",
    borderStyle: "solid",
    borderColor: "#f85149",
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  return _redDeco;
}
