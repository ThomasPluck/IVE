// Maps daemon Diagnostic events into VSCode's diagnostic collection so the
// gutter/problems panel light up without any webview involvement.

import * as vscode from "vscode";
import type { Diagnostic, Severity } from "./contracts";

export class DiagnosticBridge {
  private collection: vscode.DiagnosticCollection;

  constructor(
    private readonly workspaceRoot: string,
    context: vscode.ExtensionContext,
  ) {
    this.collection = vscode.languages.createDiagnosticCollection("ive");
    context.subscriptions.push(this.collection);
  }

  set(file: string, diagnostics: Diagnostic[]): void {
    const uri = vscode.Uri.file(this.abs(file));
    const mapped = diagnostics.map((d) => this.toVsCode(d));
    this.collection.set(uri, mapped);
  }

  clear(): void {
    this.collection.clear();
  }

  private abs(rel: string): string {
    const { join } = require("node:path") as typeof import("node:path");
    return join(this.workspaceRoot, rel);
  }

  private toVsCode(d: Diagnostic): vscode.Diagnostic {
    const range = new vscode.Range(
      new vscode.Position(d.location.range.start[0], d.location.range.start[1]),
      new vscode.Position(d.location.range.end[0], d.location.range.end[1]),
    );
    const diag = new vscode.Diagnostic(range, d.message, severityToVsCode(d.severity));
    diag.code = d.code;
    diag.source = d.source;
    if (d.related) {
      diag.relatedInformation = d.related.map(
        (r) =>
          new vscode.DiagnosticRelatedInformation(
            new vscode.Location(
              vscode.Uri.file(this.abs(r.location.file)),
              new vscode.Range(
                new vscode.Position(r.location.range.start[0], r.location.range.start[1]),
                new vscode.Position(r.location.range.end[0], r.location.range.end[1]),
              ),
            ),
            r.message,
          ),
      );
    }
    return diag;
  }
}

function severityToVsCode(s: Severity): vscode.DiagnosticSeverity {
  switch (s) {
    case "critical":
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    case "info":
      return vscode.DiagnosticSeverity.Information;
    case "hint":
      return vscode.DiagnosticSeverity.Hint;
  }
}
