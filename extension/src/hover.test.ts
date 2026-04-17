import { describe, it, expect } from "vitest";
import type { HealthScore } from "./contracts";
import { IveHoverProvider } from "./hover";

// The hover provider depends on the VSCode module we mock in
// src/__mocks__/vscode.ts. Position is mocked with { line, character }.
import * as vscode from "vscode";

function fn(
  file: string,
  [sl, sc]: [number, number],
  [el, ec]: [number, number],
  target: string,
  extras: Partial<HealthScore> = {},
): HealthScore {
  return {
    target,
    location: { file, range: { start: [sl, sc], end: [el, ec] } },
    novelty: { value: 0, daysSinceCreated: 0, recentChurnLoc: 0 },
    cognitiveComplexity: { value: 0.1, raw: 3 },
    coupling: { value: 0.05, fanIn: 1, fanOut: 2 },
    aiSignal: { value: 0, diagnosticCount: 0, hallucinatedImports: 0, untestedBlastRadius: 0 },
    composite: 0.2,
    bucket: "green",
    ...extras,
  } as HealthScore;
}

function fakeDoc(file: string) {
  return {
    uri: vscode.Uri.file(`/ws/${file}`),
  } as unknown as vscode.TextDocument;
}

describe("IveHoverProvider", () => {
  const workspace = vscode.workspace as {
    workspaceFolders?: { uri: vscode.Uri }[];
  };
  workspace.workspaceFolders = [{ uri: vscode.Uri.file("/ws") }];

  it("returns null when no enclosing symbol is found", () => {
    const p = new IveHoverProvider();
    p.setScores([fn("a.py", [0, 0], [5, 0], "a")]);
    const res = p.provideHover(fakeDoc("a.py"), new vscode.Position(10, 0));
    expect(res).toBeNull();
  });

  it("picks the smallest enclosing function", () => {
    const p = new IveHoverProvider();
    const outer = fn("a.py", [0, 0], [20, 0], "outer");
    const inner = fn("a.py", [5, 0], [10, 0], "inner", { bucket: "yellow", composite: 0.45 });
    p.setScores([outer, inner]);
    const hover = p.provideHover(fakeDoc("a.py"), new vscode.Position(7, 0));
    expect(hover).toBeDefined();
  });

  it("skips file-scoped scores (target is an object, not a symbol id)", () => {
    const p = new IveHoverProvider();
    const fileScore = {
      ...fn("a.py", [0, 0], [20, 0], "ignored"),
      target: { file: "a.py" },
    } as unknown as HealthScore;
    p.setScores([fileScore]);
    const res = p.provideHover(fakeDoc("a.py"), new vscode.Position(5, 0));
    expect(res).toBeNull();
  });
});
