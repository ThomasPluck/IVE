// Canonical UI-side view of the daemon contract. Imported from the
// extension-side contracts where possible (keep these in lockstep — any
// drift is a review-blocking bug).

export type SymbolId = string;

export interface Range {
  start: [number, number];
  end: [number, number];
}

export interface Location {
  file: string;
  range: Range;
}

export type Severity = "hint" | "info" | "warning" | "error" | "critical";

export type DiagnosticSource =
  | "pyright"
  | "tsc"
  | "rust-analyzer"
  | "semgrep"
  | "pytea"
  | "glslang"
  | "ive-hallucination"
  | "ive-cwe"
  | "ive-crossfile"
  | "ive-binding";

export interface Diagnostic {
  id: string;
  severity: Severity;
  source: DiagnosticSource;
  code: string;
  message: string;
  location: Location;
  symbol?: SymbolId;
  related?: { location: Location; message: string }[];
  fix?: { description: string; edits: { location: Location; newText: string }[] };
}

export type HealthBucket = "green" | "yellow" | "red";
export type HealthTarget = SymbolId | { file: string };

export interface HealthScore {
  target: HealthTarget;
  location: Location;
  novelty: { value: number; daysSinceCreated: number; recentChurnLoc: number };
  cognitiveComplexity: { value: number; raw: number };
  coupling: { value: number; fanIn: number; fanOut: number };
  aiSignal: {
    value: number;
    diagnosticCount: number;
    hallucinatedImports: number;
    untestedBlastRadius: number;
  };
  composite: number;
  bucket: HealthBucket;
}

export type DaemonEvent =
  | { type: "indexProgress"; filesDone: number; filesTotal: number }
  | { type: "healthUpdated"; scores: HealthScore[] }
  | { type: "diagnosticsUpdated"; file: string; diagnostics: Diagnostic[] }
  | { type: "capabilityDegraded"; capability: string; reason: string }
  | { type: "capabilityRestored"; capability: string };

export interface WorkspaceState {
  scores: HealthScore[];
  diagnostics: Record<string, Diagnostic[]>;
  capabilities: Record<string, { available: boolean; reason: string }>;
}

export type FromExtensionMessage =
  | { type: "init"; payload: { workspaceName: string } }
  | { type: "event"; payload: DaemonEvent }
  | { type: "rpcResult"; id: number; result: unknown }
  | { type: "rpcError"; id: number; error: { code: number; message: string } }
  | { type: "workspaceState"; payload: WorkspaceState }
  | { type: "status"; payload: { phase: "cold" | "indexing" | "ready" | "error"; message?: string } };

export function isFile(t: HealthTarget): t is { file: string } {
  return typeof t === "object" && t !== null && "file" in t;
}

export function fileOf(t: HealthTarget): string | null {
  return isFile(t) ? t.file : null;
}
