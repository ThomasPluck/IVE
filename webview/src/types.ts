export interface GraphNode {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  endLine: number;
  loc: number;
  language: string;
  complexity?: number;
  cognitiveComplexity?: number;
  parameterCount?: number;
  maxLoopDepth?: number;
  churnCount?: number;
  recentChurnCount?: number;
  diffStatus?: SymbolDiffStatus;
  isDeadCode?: boolean;
  fanIn?: number;
  fanOut?: number;
  coupling?: number;
  depthFromEntry?: number;
  impactRadius?: number;
  module?: string;
}

export interface GraphEdge {
  sourceId: number;
  targetId: number;
  kind: 'call';
  isCycle?: boolean;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rootIds: number[];
}

export type SymbolDiffStatus = 'added' | 'modified' | 'deleted' | 'unchanged';

export interface ProjectCoverage {
  totalFunctions: number;
  reachableCount: number;
  deadCodeIds: number[];
  entryPointIds: number[];
  coveragePercent: number;
}

export interface DashboardData {
  coverage: ProjectCoverage;
  annotationCount: number;
  unannotatedNodes: number;
  unannotatedEdges: number;
  testCoverage: { tested: number; total: number };
  architectureStatus: { pass: boolean; violations: number; compliant: number };
  lastPerf: { totalMs: number; changedFiles: number; totalFiles: number; skipped: boolean } | null;
  risks: Array<{ id: number; name: string; coupling: number; impact: number; cc: number; file: string }>;
}

export interface NodeDetailData {
  node: GraphNode;
  callers: Array<GraphNode & { callLine?: number; callText?: string }>;
  callees: Array<GraphNode & { callLine?: number; callText?: string }>;
  annotations: Array<{ tags: string[]; label: string; explanation: string; algorithmicComplexity: string; spatialComplexity: string; pitfalls: string[] }>;
}

export interface DrillEntry {
  symbolId: number;
  name: string;
}

export type ExtensionToWebviewMessage =
  | { type: 'graphData'; data: GraphData }
  | { type: 'diffData'; data: GraphData }
  | { type: 'indexProgress'; current: number; total: number }
  | { type: 'coverageData'; data: ProjectCoverage }
  | { type: 'dashboard'; data: DashboardData }
  | { type: 'nodeDetail'; data: NodeDetailData };

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'navigate'; filePath: string; line: number }
  | { type: 'drillDown'; symbolId: number }
  | { type: 'drillUp'; parentId: number | null }
  | { type: 'search'; query: string }
  | { type: 'getDiff' }
  | { type: 'getCoverage' }
  | { type: 'showDeadCode' }
  | { type: 'selectNode'; symbolId: number };
