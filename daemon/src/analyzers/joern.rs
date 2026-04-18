//! Workstream C — Joern/CPG integration.
//!
//! Shape today:
//! 1. **Presence detection** (`jre_present` + `joern_present` +
//!    `available`). When both JRE and Joern are on PATH,
//!    `capabilities.status.cpg.available` flips to true, which stops the
//!    UI nagging about a permanently-degraded capability.
//! 2. **Cross-file slice subprocess**: when Joern is present AND the
//!    caller passes `request.cross_file = true`, we shell out to
//!    `joern --script` with a generated CPGQL script that builds (or
//!    loads) a CPG from the workspace and walks reachable flows from
//!    the origin. The output is parsed into `Slice` nodes. This path
//!    is **opt-in** via `IVE_ENABLE_JOERN=1` because Joern's JVM
//!    cold-start is 3–5s and different Joern versions produce slightly
//!    different JSON shapes — we don't want an unexpected version on a
//!    user's PATH to stall every cross-file slice request.
//!
//! When disabled or unavailable the caller falls back to the intra-
//! function slicer (`analyzers::slice`), which is already the default
//! for `cross_file = false`.
//!
//! The generated CPGQL script lives in a tempfile per invocation. It:
//!   - creates a CPG from the workspace via `importCode`
//!   - resolves the origin method by filename + line
//!   - collects `reachableByFlows` for backward slicing or
//!     `reachableBy` for forward
//!   - emits JSON with one object per flow node
//!
//! If Joern's output can't be parsed (version drift) we return None and
//! the caller degrades.

use crate::contracts::{
    Location, Range, Slice, SliceDirection, SliceEdge, SliceEdgeKind, SliceKind, SliceNode,
    SliceRequest,
};
use std::path::Path;
use std::process::Command;
use std::time::Instant;

pub fn jre_present() -> bool {
    if std::env::var("IVE_SKIP_JOERN").is_ok() {
        return false;
    }
    Command::new("java")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn joern_present() -> bool {
    if std::env::var("IVE_SKIP_JOERN").is_ok() {
        return false;
    }
    Command::new("joern")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn available() -> bool {
    jre_present() && joern_present()
}

/// Whether the real CPG slice subprocess path is opted into. Users run
/// `IVE_ENABLE_JOERN=1` to activate it once they've confirmed their
/// Joern version matches what the generated script expects.
pub fn slice_subprocess_enabled() -> bool {
    std::env::var("IVE_ENABLE_JOERN").is_ok() && available()
}

pub fn degraded_reason() -> &'static str {
    "Joern/CPG integration pending full activation. Install JRE 17+ and the Joern CLI, then `IVE_ENABLE_JOERN=1` to enable cross-file slicing; meanwhile `slice.compute` runs an intra-function AST slice only."
}

/// Cross-file slice via Joern. Returns `None` when the feature isn't
/// enabled or Joern's output can't be parsed — caller falls back to
/// `capabilityDegraded{capability:"cpg"}`.
pub fn compute_cross_file_slice(root: &Path, request: &SliceRequest) -> Option<Slice> {
    if !slice_subprocess_enabled() {
        return None;
    }
    let started = Instant::now();
    let script = build_cpgql_script(root, request);
    let tmp = std::env::temp_dir().join(format!(
        "ive-joern-{}-{}.sc",
        std::process::id(),
        started.elapsed().as_nanos()
    ));
    if std::fs::write(&tmp, &script).is_err() {
        return None;
    }
    let output = Command::new("joern").arg("--script").arg(&tmp).output();
    let _ = std::fs::remove_file(&tmp);
    let output = output.ok()?;
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let nodes = parse_joern_flow_json(&text, &request.origin.file)?;

    let edges: Vec<SliceEdge> = (1..nodes.len() as u32)
        .map(|i| SliceEdge {
            from: i - 1,
            to: i,
            kind: SliceEdgeKind::Data,
        })
        .collect();
    let truncated = matches!(request.kind, SliceKind::Full);
    Some(Slice {
        request: request.clone(),
        nodes,
        edges,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn build_cpgql_script(root: &Path, request: &SliceRequest) -> String {
    let root_str = root.to_string_lossy().replace('"', "\\\"");
    let origin_line = request.origin.range.start[0] + 1; // CPGQL is 1-indexed
    let origin_file = request.origin.file.replace('"', "\\\"");
    let direction = match request.direction {
        SliceDirection::Backward => "reachableByFlows",
        SliceDirection::Forward => "reachableBy",
    };
    let max_hops = request.max_hops.unwrap_or(10);
    // Generate a Scala-friendly CPGQL script. Different Joern versions
    // expose slightly different APIs; we stick to the 2.x public surface.
    format!(
        r#"
importCode(inputPath = "{root}", projectName = "ive-cross-file")
val sinks = cpg.call.filename("{file}").lineNumber({line}).l
val flows = sinks.{direction}(cpg.method.ast).l
val limited = flows.take({max_hops})
val out = limited.map {{ node =>
  s"""{{"file":"${{node.file.name.headOption.getOrElse("")}}","line":${{node.lineNumber.getOrElse(0)}},"label":"${{node.code.replace("\"", "'")}}""""
}}
println("[IVE-JOERN-BEGIN]")
out.foreach(println)
println("[IVE-JOERN-END]")
"#,
        root = root_str,
        file = origin_file,
        line = origin_line,
        direction = direction,
        max_hops = max_hops,
    )
}

fn parse_joern_flow_json(text: &str, fallback_file: &str) -> Option<Vec<SliceNode>> {
    // Extract the delimited chunk; everything else is Joern's banner/log.
    let begin = text.find("[IVE-JOERN-BEGIN]")?;
    let end = text.find("[IVE-JOERN-END]")?;
    if end <= begin {
        return None;
    }
    let inner = &text[begin + "[IVE-JOERN-BEGIN]".len()..end];

    let mut out = Vec::new();
    for (i, raw) in inner.lines().filter(|l| !l.trim().is_empty()).enumerate() {
        let line = raw.trim();
        if !line.starts_with('{') {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let file = value
            .get("file")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback_file)
            .to_string();
        let lineno = value
            .get("line")
            .and_then(|v| v.as_i64())
            .unwrap_or(1)
            .max(1) as u32
            - 1;
        let label = value
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("<node>")
            .chars()
            .take(80)
            .collect();
        out.push(SliceNode {
            id: i as u32,
            location: Location {
                file,
                range: Range {
                    start: [lineno, 0],
                    end: [lineno, 0],
                },
            },
            label,
        });
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{Location, Range, SliceDirection, SliceKind};

    #[test]
    fn skip_env_disables_detection() {
        std::env::set_var("IVE_SKIP_JOERN", "1");
        assert!(!jre_present());
        assert!(!joern_present());
        assert!(!available());
        std::env::remove_var("IVE_SKIP_JOERN");
    }

    #[test]
    fn slice_subprocess_disabled_without_env() {
        std::env::set_var("IVE_SKIP_JOERN", "1");
        std::env::remove_var("IVE_ENABLE_JOERN");
        assert!(!slice_subprocess_enabled());
        std::env::remove_var("IVE_SKIP_JOERN");
    }

    #[test]
    fn cpgql_script_mentions_workspace_and_direction() {
        let req = SliceRequest {
            origin: Location {
                file: "src/main.py".into(),
                range: Range {
                    start: [41, 0],
                    end: [41, 0],
                },
            },
            direction: SliceDirection::Backward,
            kind: SliceKind::Thin,
            max_hops: Some(7),
            cross_file: true,
        };
        let script = build_cpgql_script(Path::new("/ws"), &req);
        assert!(script.contains("importCode"));
        assert!(script.contains("reachableByFlows"));
        assert!(script.contains("src/main.py"));
        // CPGQL is 1-indexed; we translate from the 0-indexed contract.
        assert!(script.contains("lineNumber(42)"));
        assert!(script.contains("take(7)"));
    }

    #[test]
    fn parse_joern_flow_json_handles_delimited_block() {
        let raw = r#"
welcome banner line
scala>
[IVE-JOERN-BEGIN]
{"file":"src/a.py","line":12,"label":"x = f()"}
{"file":"src/a.py","line":7,"label":"def f(): ..."}
[IVE-JOERN-END]
scala>
"#;
        let nodes = parse_joern_flow_json(raw, "fallback.py").unwrap();
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].location.file, "src/a.py");
        assert_eq!(nodes[0].location.range.start, [11, 0]);
        assert!(nodes[0].label.starts_with("x = f"));
    }

    #[test]
    fn parse_returns_none_without_delimiters() {
        assert!(parse_joern_flow_json("just banner text", "a.py").is_none());
    }
}
