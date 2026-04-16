// Canonical JSON-RPC contract. Mirrors daemon/src/contracts.rs 1:1.
// See spec §4. Changes require a design review.

export type SymbolId = string;
export type BlobSha = string;

export interface Range {
  start: [number, number]; // [line, col], 0-indexed
  end: [number, number];
}

export interface Location {
  file: string; // workspace-relative, POSIX
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

export interface TextEdit {
  location: Location;
  newText: string;
}

export interface Fix {
  description: string;
  edits: TextEdit[];
}

export interface RelatedInfo {
  location: Location;
  message: string;
}

export interface Diagnostic {
  id: string;
  severity: Severity;
  source: DiagnosticSource;
  code: string;
  message: string;
  location: Location;
  symbol?: SymbolId;
  related?: RelatedInfo[];
  fix?: Fix;
}

export type HealthBucket = "green" | "yellow" | "red";

export interface NoveltyComponent {
  value: number;
  daysSinceCreated: number;
  recentChurnLoc: number;
}

export interface CognitiveComplexityComponent {
  value: number;
  raw: number;
}

export interface CouplingComponent {
  value: number;
  fanIn: number;
  fanOut: number;
}

export interface AiSignalComponent {
  value: number;
  diagnosticCount: number;
  hallucinatedImports: number;
  untestedBlastRadius: number;
}

export type HealthTarget = SymbolId | { file: string };

export interface HealthScore {
  target: HealthTarget;
  location: Location;
  novelty: NoveltyComponent;
  cognitiveComplexity: CognitiveComplexityComponent;
  coupling: CouplingComponent;
  aiSignal: AiSignalComponent;
  composite: number;
  bucket: HealthBucket;
}

export type SliceKind = "thin" | "full";
export type SliceDirection = "backward" | "forward";

export interface SliceRequest {
  origin: Location;
  direction: SliceDirection;
  kind: SliceKind;
  maxHops?: number;
  crossFile: boolean;
}

export interface SliceNode {
  id: number;
  location: Location;
  label: string;
}

export type SliceEdgeKind = "data" | "control" | "call";

export interface SliceEdge {
  from: number;
  to: number;
  kind: SliceEdgeKind;
}

export interface Slice {
  request: SliceRequest;
  nodes: SliceNode[];
  edges: SliceEdge[];
  truncated: boolean;
  elapsedMs: number;
}

export type SummaryDepth = "signature" | "body" | "module";

export interface SummaryRequest {
  symbol: SymbolId;
  depth: SummaryDepth;
}

export type FactKind = "signature" | "call" | "return_type" | "raises" | "reads" | "writes" | "import";

export interface Fact {
  id: string;
  kind: FactKind;
  content: string;
  sourceLocation?: Location;
}

export interface Claim {
  text: string;
  entailed: boolean;
  supportingFactIds: string[];
  reason?: string;
}

export interface GroundedSummary {
  symbol: SymbolId;
  text: string;
  factsGiven: Fact[];
  claims: Claim[];
  model: string;
  generatedAt: string; // ISO8601
}

export type DaemonEvent =
  | { type: "indexProgress"; filesDone: number; filesTotal: number }
  | { type: "healthUpdated"; scores: HealthScore[] }
  | { type: "diagnosticsUpdated"; file: string; diagnostics: Diagnostic[] }
  | { type: "capabilityDegraded"; capability: string; reason: string }
  | { type: "capabilityRestored"; capability: string };

// Method name → request/response tuples. Extension code should import
// `Methods` for type-safe `call()` dispatch.
export interface Methods {
  "workspace.scan": { request: Record<string, never>; response: null };
  "workspace.healthSummary": { request: Record<string, never>; response: HealthScore[] };
  "file.diagnostics": { request: { file: string }; response: Diagnostic[] };
  "file.list": { request: Record<string, never>; response: { file: string; loc: number; language: string }[] };
  "slice.compute": { request: SliceRequest; response: Slice };
  "summary.generate": { request: SummaryRequest; response: GroundedSummary };
  "symbol.definition": { request: { location: Location }; response: Location | null };
  "symbol.references": { request: { location: Location }; response: Location[] };
  "cache.invalidate": { request: { file?: string }; response: null };
  "capabilities.status": {
    request: Record<string, never>;
    response: Record<string, { available: boolean; reason: string }>;
  };
  "ping": { request: Record<string, never>; response: string };
  "daemon.info": { request: Record<string, never>; response: { version: string; root: string } };
}

export type MethodName = keyof Methods;
export type MethodRequest<M extends MethodName> = Methods[M]["request"];
export type MethodResponse<M extends MethodName> = Methods[M]["response"];

// ─── Webview ↔ extension messages ─────────────────────────────────

export type FromExtensionMessage =
  | { type: "init"; payload: { workspaceName: string } }
  | { type: "event"; payload: DaemonEvent }
  | { type: "rpcResult"; id: number; result: unknown }
  | { type: "rpcError"; id: number; error: { code: number; message: string } }
  | { type: "workspaceState"; payload: WorkspaceState }
  | { type: "status"; payload: { phase: "cold" | "indexing" | "ready" | "error"; message?: string } };

export interface WorkspaceState {
  scores: HealthScore[];
  diagnostics: Record<string, Diagnostic[]>;
  capabilities: Record<string, { available: boolean; reason: string }>;
}

export type FromWebviewMessage =
  | { type: "ready" }
  | { type: "rpc"; id: number; method: MethodName; params: unknown }
  | { type: "openFile"; location: Location }
  | { type: "summarize"; symbol: SymbolId }
  | { type: "sliceRequested"; request: SliceRequest };
