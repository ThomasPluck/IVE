//! Health model, canonical per `spec §6`.

use crate::config::HealthWeights;
use crate::contracts::{
    AiSignalComponent, CognitiveComplexityComponent, CouplingComponent, HealthBucket, HealthScore,
    HealthTarget, Location, NoveltyComponent, Range,
};
use crate::parser::FunctionUnit;
use crate::scanner::ScannedFile;
use std::collections::HashMap;

fn clamp01(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

pub fn bucket_for(composite: f32) -> HealthBucket {
    if composite < 0.3 {
        HealthBucket::Green
    } else if composite < 0.6 {
        HealthBucket::Yellow
    } else {
        HealthBucket::Red
    }
}

/// Score one function. In v1 we lack git churn (novelty=0 if caller doesn't
/// supply churn) and blast-radius coverage (ai_signal subterm is 0). Docs
/// surface this honestly.
pub fn score_function(
    unit: &FunctionUnit,
    weights: &HealthWeights,
    fan_in: u32,
    diagnostic_count: u32,
    hallucinated_imports: u32,
    recent_churn_loc: u32,
    has_no_tests: bool,
) -> HealthScore {
    let fan_out = unit.local_callees.len() as u32;
    let novelty = NoveltyComponent {
        value: clamp01(recent_churn_loc as f32 / 100.0),
        days_since_created: 0,
        recent_churn_loc,
    };
    let cognitive_complexity = CognitiveComplexityComponent {
        value: clamp01(unit.cognitive_complexity as f32 / 30.0),
        raw: unit.cognitive_complexity,
    };
    let coupling = CouplingComponent {
        value: clamp01((fan_in + fan_out) as f32 / 20.0),
        fan_in,
        fan_out,
    };

    // AI-signal subterms, each [0,1].
    let diag_n = clamp01(diagnostic_count as f32 / 5.0);
    let hall_n = if hallucinated_imports > 0 { 1.0 } else { 0.0 };
    let untested_blast = 0.0; // v1: unimplemented without blast-radius data
    let churn_no_tests = if recent_churn_loc > 0 && has_no_tests { 1.0 } else { 0.0 };

    let ai_value = clamp01(0.4 * diag_n + 0.3 * hall_n + 0.2 * untested_blast + 0.1 * churn_no_tests);
    let ai_signal = AiSignalComponent {
        value: ai_value,
        diagnostic_count,
        hallucinated_imports,
        untested_blast_radius: untested_blast,
    };

    let composite = weights.novelty * novelty.value
        + weights.cognitive_complexity * cognitive_complexity.value
        + weights.coupling * coupling.value
        + weights.ai_signal * ai_signal.value;
    let composite = clamp01(composite);

    HealthScore {
        target: HealthTarget::Symbol(unit.symbol_id.clone()),
        location: unit.location.clone(),
        novelty,
        cognitive_complexity,
        coupling,
        ai_signal,
        composite,
        bucket: bucket_for(composite),
    }
}

/// Aggregate function scores into a file-level score. The file's composite is
/// the LOC-weighted mean of its functions' composites, falling back to the
/// cheap file-level AI signal (hallucinated imports, diagnostics) if there are
/// zero function units.
pub fn score_file(
    file: &ScannedFile,
    _weights: &HealthWeights,
    function_scores: &[HealthScore],
    file_diagnostic_count: u32,
    hallucinated_imports: u32,
) -> HealthScore {
    let (cc_sum, cc_n, fan_in_sum, fan_out_sum, cc_weight_sum, raw_cc_sum) =
        function_scores.iter().zip(file.functions.iter()).fold(
            (0.0, 0u32, 0u32, 0u32, 0.0, 0u32),
            |(cc, n, fi, fo, w, rcc), (score, unit)| {
                let wl = unit.loc.max(1) as f32;
                (
                    cc + score.composite * wl,
                    n + 1,
                    fi + score.coupling.fan_in,
                    fo + score.coupling.fan_out,
                    w + wl,
                    rcc + unit.cognitive_complexity,
                )
            },
        );

    let mean_composite = if cc_weight_sum > 0.0 { cc_sum / cc_weight_sum } else { 0.0 };

    // File-level AI signal weights hallucinated imports strongly — a single
    // unknown import is a near-maximal slop indicator by spec (§5/F).
    let diag_n = clamp01(file_diagnostic_count as f32 / 10.0);
    let hall_n = clamp01(hallucinated_imports as f32 / 2.0);
    let ai_value = clamp01(0.3 * diag_n + 0.7 * hall_n);
    let ai_signal = AiSignalComponent {
        value: ai_value,
        diagnostic_count: file_diagnostic_count,
        hallucinated_imports,
        untested_blast_radius: 0.0,
    };

    // Canonical composite: LOC-weighted mean of function composites, blended
    // with the file-level AI signal. Then apply a severity floor: any
    // hallucinated import → at least yellow (0.4); two or more → red (0.6).
    let blended = if cc_n == 0 {
        clamp01(0.7 * ai_signal.value + 0.3 * clamp01(file.loc as f32 / 500.0))
    } else {
        clamp01(0.7 * mean_composite + 0.3 * ai_signal.value)
    };
    let severity_floor = clamp01(0.4 * hallucinated_imports as f32);
    let composite = blended.max(severity_floor);

    HealthScore {
        target: HealthTarget::File { file: file.relative_path.clone() },
        location: Location {
            file: file.relative_path.clone(),
            range: Range {
                start: [0, 0],
                end: [file.loc.saturating_sub(1), 0],
            },
        },
        novelty: NoveltyComponent {
            value: 0.0,
            days_since_created: 0,
            recent_churn_loc: 0,
        },
        cognitive_complexity: CognitiveComplexityComponent {
            value: clamp01(raw_cc_sum as f32 / (30.0 * cc_n.max(1) as f32)),
            raw: raw_cc_sum,
        },
        coupling: CouplingComponent {
            value: clamp01((fan_in_sum + fan_out_sum) as f32 / (20.0 * cc_n.max(1) as f32)),
            fan_in: fan_in_sum,
            fan_out: fan_out_sum,
        },
        ai_signal,
        composite,
        bucket: bucket_for(composite),
    }
}

/// Helper: fan-in map for all functions in a scanned workspace. Only
/// workspace-local calls count, per spec.
pub fn build_fan_in(files: &HashMap<String, ScannedFile>) -> HashMap<String, u32> {
    let mut name_index: HashMap<String, Vec<String>> = HashMap::new();
    for file in files.values() {
        for func in &file.functions {
            let leaf = func.name.rsplit('.').next().unwrap_or(&func.name).to_string();
            name_index.entry(leaf).or_default().push(func.symbol_id.clone());
        }
    }

    let mut fan_in: HashMap<String, u32> = HashMap::new();
    for file in files.values() {
        for func in &file.functions {
            for callee in &func.local_callees {
                let leaf = callee.rsplit('.').next().unwrap_or(callee).to_string();
                if let Some(symbols) = name_index.get(&leaf) {
                    for sym in symbols {
                        if sym != &func.symbol_id {
                            *fan_in.entry(sym.clone()).or_insert(0) += 1;
                        }
                    }
                }
            }
        }
    }
    fan_in
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::FunctionUnit;

    fn unit(cc: u32) -> FunctionUnit {
        FunctionUnit {
            symbol_id: "s".into(),
            name: "f".into(),
            location: Location {
                file: "m.py".into(),
                range: Range { start: [0, 0], end: [0, 0] },
            },
            cognitive_complexity: cc,
            loc: 10,
            local_callees: vec!["a".into(), "b".into()],
        }
    }

    #[test]
    fn bucket_boundaries() {
        assert_eq!(bucket_for(0.0), HealthBucket::Green);
        assert_eq!(bucket_for(0.29), HealthBucket::Green);
        assert_eq!(bucket_for(0.3), HealthBucket::Yellow);
        assert_eq!(bucket_for(0.59), HealthBucket::Yellow);
        assert_eq!(bucket_for(0.6), HealthBucket::Red);
    }

    #[test]
    fn cold_function_is_green() {
        let score = score_function(&unit(0), &HealthWeights::default(), 0, 0, 0, 0, false);
        assert_eq!(score.bucket, HealthBucket::Green);
        assert!(score.composite < 0.05);
    }

    #[test]
    fn high_complexity_pushes_to_yellow_or_red() {
        let score = score_function(&unit(30), &HealthWeights::default(), 0, 0, 0, 0, false);
        assert!(score.composite >= 0.3);
    }

    #[test]
    fn hallucinated_import_raises_ai_signal() {
        let score = score_function(&unit(0), &HealthWeights::default(), 0, 0, 1, 0, false);
        assert!(score.ai_signal.value > 0.0);
    }

    #[test]
    fn file_with_hallucinated_import_is_at_least_yellow() {
        let file = ScannedFile {
            relative_path: "a.py".into(),
            language: crate::parser::Language::Python,
            loc: 10,
            functions: vec![unit(0)],
            imports: vec![],
            blob_sha: "x".into(),
            bytes_read: 0,
            location: Location {
                file: "a.py".into(),
                range: Range { start: [0, 0], end: [10, 0] },
            },
        };
        let fn_scores = vec![score_function(
            &unit(0),
            &HealthWeights::default(),
            0,
            0,
            0,
            0,
            false,
        )];
        let score = score_file(&file, &HealthWeights::default(), &fn_scores, 1, 1);
        assert!(
            matches!(score.bucket, HealthBucket::Yellow | HealthBucket::Red),
            "one hallucinated import must push a file to at least yellow: got {:?} at {}",
            score.bucket,
            score.composite
        );
    }
}
