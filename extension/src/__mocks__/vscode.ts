// Lightweight stub so non-extension-host code under test can import `vscode`.
// Only the surface actually touched by `logger.ts` and `diagnostics.ts` is
// stubbed. Tests that exercise real VSCode API belong in the
// `@vscode/test-electron` harness, not here.

export class OutputChannel {
  appendLine(_m: string) {}
  show() {}
  dispose() {}
}

export class DiagnosticCollection {
  set(_uri: unknown, _d: unknown[]) {}
  clear() {}
  dispose() {}
}

export class Position {
  constructor(
    public line: number,
    public character: number,
  ) {}
}

export class Range {
  constructor(
    public start: Position,
    public end: Position,
  ) {}
}

export class Location {
  constructor(
    public uri: Uri,
    public range: Range,
  ) {}
}

export class Uri {
  constructor(public fsPath: string) {}
  static file(p: string) {
    return new Uri(p);
  }
  static joinPath(base: Uri, ...parts: string[]) {
    const { join } = require("node:path") as typeof import("node:path");
    return new Uri(join(base.fsPath, ...parts));
  }
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class Diagnostic {
  constructor(
    public range: Range,
    public message: string,
    public severity: DiagnosticSeverity,
  ) {}
  code?: string;
  source?: string;
  relatedInformation?: DiagnosticRelatedInformation[];
}

export class DiagnosticRelatedInformation {
  constructor(
    public location: Location,
    public message: string,
  ) {}
}

export const window = {
  createOutputChannel: () => new OutputChannel(),
};

export const languages = {
  createDiagnosticCollection: (_name: string) => new DiagnosticCollection(),
};

export const workspace = {
  workspaceFolders: undefined as { uri: Uri }[] | undefined,
};
