//! Canonical JSON-RPC contract types.
//!
//! These are the **exact** wire types described in `spec §4`. They are
//! `serde`-serialised as camelCase on the RPC wire and must stay 1:1 with
//! `extension/src/contracts.ts`. Changing any of them requires a design
//! review per §4.

use serde::{Deserialize, Serialize};

// ─── Identity ────────────────────────────────────────────────────────

pub type SymbolId = String;
pub type BlobSha = String;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    /// Workspace-relative POSIX path.
    pub file: String,
    pub range: Range,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Range {
    /// `[line, col]`, 0-indexed.
    pub start: [u32; 2],
    pub end: [u32; 2],
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Hint,
    Info,
    Warning,
    Error,
    Critical,
}

// ─── Diagnostics ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticSource {
    Pyright,
    Tsc,
    RustAnalyzer,
    Semgrep,
    Pytea,
    Glslang,
    IveHallucination,
    IveCwe,
    IveCrossfile,
    IveBinding,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub location: Location,
    pub new_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fix {
    pub description: String,
    pub edits: Vec<TextEdit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedInfo {
    pub location: Location,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub id: String,
    pub severity: Severity,
    pub source: DiagnosticSource,
    pub code: String,
    pub message: String,
    pub location: Location,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<SymbolId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<RelatedInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<Fix>,
}

// ─── Health ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum HealthTarget {
    Symbol(String),
    File { file: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HealthBucket {
    Green,
    Yellow,
    Red,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoveltyComponent {
    pub value: f32,
    pub days_since_created: u32,
    pub recent_churn_loc: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CognitiveComplexityComponent {
    pub value: f32,
    pub raw: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CouplingComponent {
    pub value: f32,
    pub fan_in: u32,
    pub fan_out: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSignalComponent {
    pub value: f32,
    pub diagnostic_count: u32,
    pub hallucinated_imports: u32,
    pub untested_blast_radius: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthScore {
    pub target: HealthTarget,
    pub location: Location,
    pub novelty: NoveltyComponent,
    pub cognitive_complexity: CognitiveComplexityComponent,
    pub coupling: CouplingComponent,
    pub ai_signal: AiSignalComponent,
    pub composite: f32,
    pub bucket: HealthBucket,
}

// ─── Slicing ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SliceKind {
    Thin,
    Full,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SliceDirection {
    Backward,
    Forward,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceRequest {
    pub origin: Location,
    pub direction: SliceDirection,
    pub kind: SliceKind,
    #[serde(default)]
    pub max_hops: Option<u32>,
    #[serde(default = "default_true")]
    pub cross_file: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceNode {
    pub id: u32,
    pub location: Location,
    pub label: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SliceEdgeKind {
    Data,
    Control,
    Call,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceEdge {
    pub from: u32,
    pub to: u32,
    pub kind: SliceEdgeKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Slice {
    pub request: SliceRequest,
    pub nodes: Vec<SliceNode>,
    pub edges: Vec<SliceEdge>,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

// ─── Grounded summaries ──────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SummaryDepth {
    Signature,
    Body,
    Module,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryRequest {
    pub symbol: SymbolId,
    pub depth: SummaryDepth,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FactKind {
    Signature,
    Call,
    ReturnType,
    Raises,
    Reads,
    Writes,
    Import,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub id: String,
    pub kind: FactKind,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_location: Option<Location>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub text: String,
    pub entailed: bool,
    pub supporting_fact_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroundedSummary {
    pub symbol: SymbolId,
    pub text: String,
    pub facts_given: Vec<Fact>,
    pub claims: Vec<Claim>,
    pub model: String,
    /// ISO8601 with timezone.
    pub generated_at: String,
}

// ─── Events (daemon → extension) ─────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DaemonEvent {
    #[serde(rename_all = "camelCase")]
    IndexProgress { files_done: u32, files_total: u32 },
    #[serde(rename_all = "camelCase")]
    HealthUpdated { scores: Vec<HealthScore> },
    #[serde(rename_all = "camelCase")]
    DiagnosticsUpdated { file: String, diagnostics: Vec<Diagnostic> },
    #[serde(rename_all = "camelCase")]
    CapabilityDegraded { capability: String, reason: String },
    #[serde(rename_all = "camelCase")]
    CapabilityRestored { capability: String },
}

// ─── Method params / results ────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRequest {
    pub file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationRequest {
    pub location: Location,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInvalidateRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_round_trips_as_camel_case() {
        let d = Diagnostic {
            id: "x".into(),
            severity: Severity::Critical,
            source: DiagnosticSource::IveHallucination,
            code: "ive-hallucination/unknown-import".into(),
            message: "no package 'foo'".into(),
            location: Location {
                file: "a/b.py".into(),
                range: Range { start: [2, 0], end: [2, 10] },
            },
            symbol: None,
            related: vec![],
            fix: None,
        };
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["severity"], "critical");
        assert_eq!(v["source"], "ive-hallucination");
        assert_eq!(v["location"]["file"], "a/b.py");
        let back: Diagnostic = serde_json::from_value(v).unwrap();
        assert_eq!(back.code, d.code);
    }

    #[test]
    fn health_bucket_serialises_lowercase() {
        assert_eq!(
            serde_json::to_value(HealthBucket::Yellow).unwrap(),
            serde_json::Value::String("yellow".into())
        );
    }

    #[test]
    fn daemon_event_is_tagged_on_type() {
        let e = DaemonEvent::IndexProgress { files_done: 3, files_total: 10 };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["type"], "indexProgress");
        assert_eq!(v["filesDone"], 3);
        assert_eq!(v["filesTotal"], 10);
    }
}
