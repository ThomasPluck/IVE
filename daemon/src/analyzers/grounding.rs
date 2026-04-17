//! Workstream G — grounded LLM summaries + entailment gate.
//!
//! Behaviour:
//! - If `ANTHROPIC_API_KEY` is set, call Claude with a prompt built from
//!   the extracted facts and ask for a prose summary that uses *only*
//!   those facts. Claims are then extracted from the response and each
//!   one is checked against the fact set for entailment.
//! - Otherwise, fall back to a deterministic fact-only rendering where
//!   every claim is trivially entailed (because it *is* a fact).
//!
//! The entailment gate is deliberately simple at v1: for each claim
//! sentence, walk the facts and mark `entailed=true` if any fact's
//! content shares ≥1 noun-like token with the claim. When workstream G
//! properly lands, this becomes a proper NLI step against a CPG-indexed
//! fact graph.

use crate::contracts::{Claim, Fact, FactKind, GroundedSummary, Location, Range, SymbolId};
use crate::parser::FunctionUnit;
use crate::scanner::ScannedFile;
use std::time::SystemTime;

pub fn summarize(file: &ScannedFile, unit: &FunctionUnit) -> GroundedSummary {
    let facts = extract_facts(file, unit);
    if let Ok(api_key) = std::env::var("ANTHROPIC_API_KEY") {
        if !api_key.is_empty() {
            if let Some(s) = llm_summary(unit, &facts, &api_key) {
                return s;
            }
        }
    }
    offline_summary(unit, facts)
}

pub fn offline_summary(unit: &FunctionUnit, facts: Vec<Fact>) -> GroundedSummary {
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

pub fn extract_facts(file: &ScannedFile, unit: &FunctionUnit) -> Vec<Fact> {
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
    facts
}

/// Call Claude with the facts. Returns None on any error (network, non-200,
/// unparseable JSON) and the caller falls back to the offline path.
fn llm_summary(unit: &FunctionUnit, facts: &[Fact], api_key: &str) -> Option<GroundedSummary> {
    let model = std::env::var("IVE_LLM_MODEL").unwrap_or_else(|_| "claude-haiku-4-5".into());
    let system = "You explain code using only the facts listed. Never add information not present in the facts. Keep it to 3–5 short sentences. Be specific.";
    let mut user = String::new();
    user.push_str(&format!("Function: {}\n", unit.name));
    user.push_str(&format!("LOC: {}\n", unit.loc));
    user.push_str("\nFacts:\n");
    for f in facts {
        user.push_str(&format!("- ({}) {}\n", f.id, f.content));
    }
    user.push_str("\nWrite a grounded summary using only these facts.");

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 400,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    });

    let resp = ureq::post("https://api.anthropic.com/v1/messages")
        .set("x-api-key", api_key)
        .set("anthropic-version", "2023-06-01")
        .set("content-type", "application/json")
        .send_json(body)
        .ok()?;
    let parsed: serde_json::Value = resp.into_json().ok()?;
    let text_out = parsed
        .get("content")?
        .as_array()?
        .iter()
        .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    let claims = gate_claims(&text_out, facts);
    Some(GroundedSummary {
        symbol: unit.symbol_id.clone(),
        text: text_out,
        facts_given: facts.to_vec(),
        claims,
        model,
        generated_at: iso8601_now(),
    })
}

/// Entailment gate v1: split the response into sentences, then for each
/// sentence mark entailed=true iff any fact's content shares ≥1 significant
/// lowercase token with the sentence. Significant = length ≥ 3 and not a
/// common stop-word. Unentailed claims carry a reason.
pub fn gate_claims(text: &str, facts: &[Fact]) -> Vec<Claim> {
    let sentences = split_sentences(text);
    sentences
        .into_iter()
        .map(|s| evaluate_claim(&s, facts))
        .collect()
}

fn evaluate_claim(sentence: &str, facts: &[Fact]) -> Claim {
    let tokens = significant_tokens(sentence);
    let mut supporting: Vec<String> = Vec::new();
    for f in facts {
        let fact_tokens = significant_tokens(&f.content);
        if tokens.iter().any(|t| fact_tokens.contains(t)) {
            supporting.push(f.id.clone());
        }
    }
    let entailed = !supporting.is_empty();
    Claim {
        text: sentence.to_string(),
        entailed,
        supporting_fact_ids: supporting,
        reason: if entailed {
            None
        } else {
            Some("no supporting fact found for this claim".into())
        },
    }
}

fn split_sentences(text: &str) -> Vec<String> {
    // Break on a sentence terminator (`.`, `!`, `?`) only when followed by
    // whitespace or end-of-input — so `json.loads`, `v1.1`, `foo.bar()`
    // stay intact inside a single claim.
    let mut out = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = text.chars().collect();
    for (i, ch) in chars.iter().enumerate() {
        cur.push(*ch);
        let is_terminator = matches!(ch, '.' | '!' | '?');
        if !is_terminator {
            continue;
        }
        let next_is_boundary = match chars.get(i + 1) {
            None => true,
            Some(c) => c.is_whitespace(),
        };
        if next_is_boundary {
            let trimmed = cur.trim().to_string();
            if !trimmed.is_empty() {
                out.push(trimmed);
            }
            cur.clear();
        }
    }
    let tail = cur.trim().to_string();
    if !tail.is_empty() {
        out.push(tail);
    }
    out
}

fn significant_tokens(s: &str) -> std::collections::HashSet<String> {
    const STOP: &[&str] = &[
        "the", "and", "for", "with", "from", "this", "that", "its", "into", "over", "than", "then",
        "when", "which", "will", "would", "have", "has", "had", "not", "but", "are", "was", "were",
        "been", "being", "also", "such", "them", "they", "their", "there", "these", "those",
        "only", "each", "any", "some", "all", "one", "two", "function", "calls", "call", "imports",
        "import", "uses", "use", "use:", "it", "is", "in", "on", "to", "of", "as",
    ];
    s.split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|t| t.len() >= 3)
        .map(|t| t.to_ascii_lowercase())
        .filter(|t| !STOP.contains(&t.as_str()))
        .collect()
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

    fn make_inputs() -> (ScannedFile, FunctionUnit) {
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
                range: Range {
                    start: [0, 0],
                    end: [0, 0],
                },
            },
        };
        let unit = FunctionUnit {
            symbol_id: "s".into(),
            name: "f".into(),
            location: Location {
                file: "a.py".into(),
                range: Range {
                    start: [0, 0],
                    end: [0, 0],
                },
            },
            cognitive_complexity: 0,
            loc: 5,
            local_callees: vec!["print".into()],
        };
        (file, unit)
    }

    #[test]
    fn offline_summary_has_matching_claims_for_every_fact() {
        let (file, unit) = make_inputs();
        let facts = extract_facts(&file, &unit);
        let s = offline_summary(&unit, facts);
        assert!(s.claims.iter().all(|c| c.entailed));
        assert!(!s.facts_given.is_empty());
    }

    #[test]
    fn iso8601_has_z_suffix() {
        assert!(iso8601_now().ends_with('Z'));
    }

    #[test]
    fn gate_strikes_claims_with_no_fact_overlap() {
        let facts = vec![Fact {
            id: "f1".into(),
            kind: FactKind::Call,
            content: "calls validate_payload".into(),
            source_location: None,
        }];
        let text = "The function calls validate_payload. It also persists to Redis for caching.";
        let claims = gate_claims(text, &facts);
        assert!(claims.len() >= 2);
        // First claim should be entailed (shares validate_payload)
        let v = claims
            .iter()
            .find(|c| c.text.contains("validate_payload"))
            .unwrap();
        assert!(v.entailed, "validate_payload claim should be entailed");
        // Redis claim has no overlap → not entailed.
        let redis = claims.iter().find(|c| c.text.contains("Redis")).unwrap();
        assert!(!redis.entailed, "redis claim should be struck: {:?}", redis);
        assert!(redis.reason.is_some());
    }

    #[test]
    fn gate_accepts_a_fully_grounded_summary() {
        let facts = vec![
            Fact {
                id: "f1".into(),
                kind: FactKind::Call,
                content: "calls requests.get".into(),
                source_location: None,
            },
            Fact {
                id: "f2".into(),
                kind: FactKind::Signature,
                content: "function fetch".into(),
                source_location: None,
            },
        ];
        let text = "The fetch function uses requests.get to retrieve a URL.";
        let claims = gate_claims(text, &facts);
        assert!(claims.iter().all(|c| c.entailed), "got: {:?}", claims);
    }

    #[test]
    fn split_sentences_handles_mixed_terminators() {
        let s = "One. Two! Three? four";
        assert_eq!(split_sentences(s).len(), 4);
    }
}
