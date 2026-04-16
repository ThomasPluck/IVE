//! Workstream G — grounded LLM summaries + entailment gate.
//!
//! v1 stub: the `summary.generate` RPC returns a synthesised, fact-only
//! summary — no LLM call is made — with every statement surfaced as a
//! separately-entailed `Claim`. This is safe by construction: every claim
//! maps to a fact, so the gate never needs to strike anything.
//!
//! When workstream G lands, this file becomes:
//! - fact extraction (from state + CPG)
//! - prompt assembly
//! - LLM client (Anthropic default; others optional)
//! - claim extraction
//! - entailment verification against the fact set

use crate::contracts::{Claim, Fact, FactKind, GroundedSummary, Location, Range, SymbolId};
use crate::parser::FunctionUnit;
use crate::scanner::ScannedFile;
use std::time::SystemTime;

pub fn offline_summary(file: &ScannedFile, unit: &FunctionUnit) -> GroundedSummary {
    let mut facts = Vec::new();
    facts.push(Fact {
        id: "f-sig".into(),
        kind: FactKind::Signature,
        content: format!("function {} ({} LOC)", unit.name, unit.loc),
        source_location: Some(unit.location.clone()),
    });

    for (i, callee) in unit.local_callees.iter().enumerate() {
        facts.push(Fact {
            id: format!("f-call-{i}"),
            kind: FactKind::Call,
            content: format!("calls {callee}"),
            source_location: None,
        });
    }

    for (i, imp) in file.imports.iter().enumerate() {
        facts.push(Fact {
            id: format!("f-imp-{i}"),
            kind: FactKind::Import,
            content: format!("imports {}", imp.module),
            source_location: Some(Location {
                file: file.relative_path.clone(),
                range: Range {
                    start: imp.range_start,
                    end: imp.range_end,
                },
            }),
        });
    }

    // Offline text is pure fact-recitation — every sentence has a fact id.
    let text = render_from_facts(&facts, &unit.name);

    let claims: Vec<Claim> = facts
        .iter()
        .map(|f| Claim {
            text: f.content.clone(),
            entailed: true,
            supporting_fact_ids: vec![f.id.clone()],
            reason: None,
        })
        .collect();

    GroundedSummary {
        symbol: unit.symbol_id.clone(),
        text,
        facts_given: facts,
        claims,
        model: "ive-offline".into(),
        generated_at: iso8601_now(),
    }
}

fn render_from_facts(facts: &[Fact], symbol: &str) -> String {
    let mut lines = vec![format!("{symbol}:")];
    for f in facts {
        lines.push(format!("- {}", f.content));
    }
    lines.push(
        "(no LLM available — this summary is a fact-only rendering. Workstream G will enable grounded prose.)"
            .into(),
    );
    lines.join("\n")
}

fn iso8601_now() -> String {
    // Lightweight ISO8601 emitter to avoid a chrono dependency on the hot path.
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Convert secs to UTC broken-down date using a simple algorithm.
    let (y, mo, d, h, mi, s) = unix_to_ymdhms(secs as i64);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn unix_to_ymdhms(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400) as u32;
    let h = secs_of_day / 3600;
    let mi = (secs_of_day / 60) % 60;
    let s = secs_of_day % 60;

    // Algorithm: count from 1970-01-01.
    let mut year: i64 = 1970;
    let mut days_left = days;
    loop {
        let ly = is_leap(year);
        let y_days = if ly { 366 } else { 365 };
        if days_left < y_days as i64 {
            break;
        }
        days_left -= y_days as i64;
        year += 1;
    }
    let months = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1u32;
    for (i, m) in months.iter().enumerate() {
        let days_in_month = if i == 1 && is_leap(year) { 29 } else { *m };
        if days_left < days_in_month as i64 {
            month = (i + 1) as u32;
            break;
        }
        days_left -= days_in_month as i64;
    }
    let day = (days_left + 1) as u32;
    (year, month, day, h, mi, s)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

#[allow(dead_code)]
pub fn unimplemented_symbol_summary(symbol: SymbolId) -> GroundedSummary {
    GroundedSummary {
        symbol: symbol.clone(),
        text: "Symbol not indexed yet. Run workspace.scan first.".into(),
        facts_given: vec![],
        claims: vec![],
        model: "ive-offline".into(),
        generated_at: iso8601_now(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::Range;
    use crate::parser::FunctionUnit;

    #[test]
    fn offline_summary_has_matching_claims_for_every_fact() {
        let file = ScannedFile {
            relative_path: "a.py".into(),
            language: crate::parser::Language::Python,
            loc: 5,
            functions: vec![],
            imports: vec![],
            blob_sha: "x".into(),
            bytes_read: 0,
            location: Location {
                file: "a.py".into(),
                range: Range { start: [0, 0], end: [0, 0] },
            },
        };
        let unit = FunctionUnit {
            symbol_id: "s".into(),
            name: "f".into(),
            location: Location {
                file: "a.py".into(),
                range: Range { start: [0, 0], end: [0, 0] },
            },
            cognitive_complexity: 0,
            loc: 5,
            local_callees: vec!["print".into()],
        };
        let s = offline_summary(&file, &unit);
        assert!(s.claims.iter().all(|c| c.entailed));
        assert!(!s.facts_given.is_empty());
    }

    #[test]
    fn iso8601_has_z_suffix() {
        assert!(iso8601_now().ends_with('Z'));
    }
}
