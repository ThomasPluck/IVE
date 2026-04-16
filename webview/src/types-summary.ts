import type { Location, SymbolId } from "./types";

export type FactKind =
  | "signature"
  | "call"
  | "return_type"
  | "raises"
  | "reads"
  | "writes"
  | "import";

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
  generatedAt: string;
}
