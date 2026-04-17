// Hover provider that appends an "IVE: health <bucket> · cc N · coupling M"
// line to VSCode's native hover for the function enclosing the cursor.
// Spec §7.7.
//
// The daemon already publishes per-function HealthScore via
// `healthUpdated` events; we cache the latest list and match by range.

import * as vscode from "vscode";
import type { HealthScore } from "./contracts";

export class IveHoverProvider implements vscode.HoverProvider {
  private scores: HealthScore[] = [];

  setScores(scores: HealthScore[]): void {
    this.scores = scores;
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.ProviderResult<vscode.Hover> {
    const file = workspaceRelative(document.uri);
    if (!file) return null;
    const candidates = this.scores.filter(
      (s) => s.location.file === file && typeof s.target === "string",
    );
    const enclosing = smallestEnclosing(candidates, position);
    if (!enclosing) return null;
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    const bucketEmoji =
      enclosing.bucket === "red" ? "🟥" : enclosing.bucket === "yellow" ? "🟨" : "🟩";
    md.appendMarkdown(
      `**IVE** ${bucketEmoji} \`${enclosing.bucket}\` · composite ${enclosing.composite.toFixed(2)}\n\n`,
    );
    md.appendMarkdown(
      `- cognitive complexity: **${enclosing.cognitiveComplexity.raw}** (${enclosing.cognitiveComplexity.value.toFixed(2)})\n`,
    );
    md.appendMarkdown(
      `- coupling: fan-in **${enclosing.coupling.fanIn}**, fan-out **${enclosing.coupling.fanOut}**\n`,
    );
    if (enclosing.aiSignal.hallucinatedImports > 0) {
      md.appendMarkdown(
        `- AI signal: **${enclosing.aiSignal.hallucinatedImports}** hallucinated import(s)\n`,
      );
    }
    return new vscode.Hover(md);
  }
}

function workspaceRelative(uri: vscode.Uri): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  const base = folders[0].uri.fsPath;
  const p = uri.fsPath;
  if (!p.startsWith(base)) return null;
  return p.slice(base.length + 1).split(/[\\/]/).join("/");
}

function smallestEnclosing(
  scores: HealthScore[],
  pos: vscode.Position,
): HealthScore | null {
  let best: HealthScore | null = null;
  let bestSize = Infinity;
  for (const s of scores) {
    const sr = s.location.range;
    if (
      (sr.start[0] < pos.line || (sr.start[0] === pos.line && sr.start[1] <= pos.character)) &&
      (sr.end[0] > pos.line || (sr.end[0] === pos.line && sr.end[1] >= pos.character))
    ) {
      const size = (sr.end[0] - sr.start[0]) * 1000 + (sr.end[1] - sr.start[1]);
      if (size < bestSize) {
        bestSize = size;
        best = s;
      }
    }
  }
  return best;
}
