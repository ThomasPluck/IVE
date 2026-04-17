//! Entailment-gate evaluation harness (`spec §8`).
//!
//! Reads every `test/grounding/*.json` case, runs each sentence-level
//! label through `grounding::gate_claims`, and computes precision /
//! recall against the human labels. The targets are:
//!
//! - precision ≥ 0.9 — striking a real claim is worse than missing one.
//! - recall    ≥ 0.7 — the gate catches the majority of fabrications.
//!
//! Either threshold slipping fails the build. The current corpus seeds
//! the spec's goal of 100 hand-labeled pairs; future PRs should grow
//! it. Cases where the gate would only pass via a quirk (e.g. a stop
//! word match) are deliberately excluded from the seed set.

use ive_daemon::analyzers::grounding;
use ive_daemon::contracts::{Fact, FactKind};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
struct Case {
    #[allow(dead_code)]
    id: String,
    facts: Vec<FactJson>,
    #[allow(dead_code)]
    summary: String,
    labels: Vec<Label>,
}

#[derive(Debug, Deserialize)]
struct FactJson {
    id: String,
    kind: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct Label {
    sentence: String,
    entailed: bool,
}

fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("test")
        .join("grounding")
}

fn load_cases() -> Vec<Case> {
    let mut cases = Vec::new();
    let dir = corpus_dir();
    for entry in std::fs::read_dir(&dir).expect("grounding corpus dir") {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let case: Case =
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
        cases.push(case);
    }
    cases
}

fn to_facts(json: &[FactJson]) -> Vec<Fact> {
    json.iter()
        .map(|f| Fact {
            id: f.id.clone(),
            kind: fact_kind(&f.kind),
            content: f.content.clone(),
            source_location: None,
        })
        .collect()
}

fn fact_kind(s: &str) -> FactKind {
    match s {
        "signature" => FactKind::Signature,
        "call" => FactKind::Call,
        "return_type" => FactKind::ReturnType,
        "raises" => FactKind::Raises,
        "reads" => FactKind::Reads,
        "writes" => FactKind::Writes,
        "import" => FactKind::Import,
        other => panic!("unknown fact kind in corpus: {other}"),
    }
}

#[derive(Default)]
struct Scoreboard {
    /// Gate said unentailed AND truth said unentailed.
    true_positive: u32,
    /// Gate said unentailed but truth said entailed.
    false_positive: u32,
    /// Gate said entailed but truth said unentailed.
    false_negative: u32,
    /// Gate said entailed AND truth said entailed.
    #[allow(dead_code)]
    true_negative: u32,
    total: u32,
}

impl Scoreboard {
    fn precision(&self) -> f32 {
        let flagged = self.true_positive + self.false_positive;
        if flagged == 0 {
            1.0
        } else {
            self.true_positive as f32 / flagged as f32
        }
    }

    fn recall(&self) -> f32 {
        let actually_bad = self.true_positive + self.false_negative;
        if actually_bad == 0 {
            1.0
        } else {
            self.true_positive as f32 / actually_bad as f32
        }
    }
}

#[test]
fn entailment_gate_meets_spec_precision_and_recall() {
    let cases = load_cases();
    // The spec targets 100 hand-labeled pairs. The floor ratchets up as PRs
    // grow the corpus — dropping cases is a deliberate call, not a silent
    // regression.
    assert!(
        cases.len() >= 30,
        "grounding corpus must keep ≥30 cases; found {}",
        cases.len()
    );

    let mut board = Scoreboard::default();

    for case in &cases {
        let facts = to_facts(&case.facts);
        // Feed the full summary (joined labels) through the gate so it sees
        // the same text it would see at runtime.
        let text = case
            .labels
            .iter()
            .map(|l| l.sentence.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let claims = grounding::gate_claims(&text, &facts);
        assert_eq!(
            claims.len(),
            case.labels.len(),
            "case {} produced {} claims but has {} labels",
            case.id,
            claims.len(),
            case.labels.len()
        );
        for (claim, label) in claims.iter().zip(case.labels.iter()) {
            let gate_says_unentailed = !claim.entailed;
            let truth_says_unentailed = !label.entailed;
            match (gate_says_unentailed, truth_says_unentailed) {
                (true, true) => board.true_positive += 1,
                (true, false) => board.false_positive += 1,
                (false, true) => board.false_negative += 1,
                (false, false) => board.true_negative += 1,
            }
            board.total += 1;
        }
    }

    let precision = board.precision();
    let recall = board.recall();

    eprintln!(
        "grounding eval: cases={}  claims={}  precision={:.3}  recall={:.3}",
        cases.len(),
        board.total,
        precision,
        recall,
    );

    assert!(
        precision >= 0.9,
        "entailment gate precision regressed: {precision:.3} < 0.9 \
        (tp={}, fp={}, corpus size={})",
        board.true_positive,
        board.false_positive,
        cases.len(),
    );
    assert!(
        recall >= 0.7,
        "entailment gate recall regressed: {recall:.3} < 0.7 \
        (tp={}, fn={}, corpus size={})",
        board.true_positive,
        board.false_negative,
        cases.len(),
    );
}
