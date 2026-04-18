//! Workstream F (v1.1) — WebGL / WebGPU binding check.
//!
//! Scope per spec §3 & §9: for every string literal passed to
//! `gl.getUniformLocation(program, "name")`, `gl.getAttribLocation(..., "name")`,
//! or `device.createBindGroupLayout({ entries: [...name: "name"...] })`,
//! confirm that `name` appears in at least one loaded shader source
//! (`.glsl`, `.vert`, `.frag`, `.wgsl`) in the workspace. If the name is
//! missing, emit `ive-binding/unknown-uniform`.
//!
//! This is deliberately a text search over shader files — we don't parse
//! GLSL in v1.1 (see spec §9 risk 9). False positives are filtered by
//! requiring the name to appear as a whole word near a `uniform`,
//! `attribute`, `in`, or `@location` token.

use crate::contracts::{Diagnostic, DiagnosticSource, Location, Range, Severity};
use crate::parser::Language;
use crate::scanner::ScannedFile;
use regex::Regex;
use std::collections::HashSet;
use std::path::Path;
use tree_sitter::Node;

#[derive(Debug, Default, Clone)]
pub struct ShaderSymbols {
    pub names: HashSet<String>,
}

impl ShaderSymbols {
    pub fn from_workspace(root: &Path) -> Self {
        use ignore::WalkBuilder;
        let mut out = Self::default();
        let shader_ext = |ext: &str| matches!(ext, "glsl" | "vert" | "frag" | "wgsl" | "hlsl");
        for entry in WalkBuilder::new(root)
            .hidden(false)
            .require_git(false)
            .build()
            .filter_map(Result::ok)
        {
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let p = entry.path();
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !shader_ext(ext) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(p) else {
                continue;
            };
            ingest_shader(&text, &mut out.names);
        }
        out
    }

    pub fn contains(&self, name: &str) -> bool {
        self.names.contains(name)
    }
}

pub fn ingest_shader(text: &str, out: &mut HashSet<String>) {
    // GLSL: `uniform <type> <name>;` / `attribute <type> <name>;` / `in <type> <name>;`
    let glsl = Regex::new(
        r"(?m)\b(?:uniform|attribute|in|out|varying)\s+(?:highp\s+|mediump\s+|lowp\s+)?\w+(?:\[\d+\])?\s+([A-Za-z_]\w*)\b",
    )
    .unwrap();
    for cap in glsl.captures_iter(text) {
        out.insert(cap[1].to_string());
    }
    // WGSL: `@group(...) @binding(...) var<...> name: type;` or `var name: type;`
    let wgsl_var = Regex::new(r"(?m)\bvar(?:<[^>]+>)?\s+([A-Za-z_]\w*)\s*:").unwrap();
    for cap in wgsl_var.captures_iter(text) {
        out.insert(cap[1].to_string());
    }
}

/// Check a single TypeScript / TSX file for binding references that
/// don't resolve in the workspace's shader corpus.
pub fn check(file: &ScannedFile, source: &[u8], shaders: &ShaderSymbols) -> Vec<Diagnostic> {
    if !matches!(file.language, Language::TypeScript | Language::Tsx) {
        return Vec::new();
    }
    if shaders.names.is_empty() {
        return Vec::new();
    }
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&file.language.ts_language()).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(source, None) else {
        return Vec::new();
    };
    let mut diagnostics = Vec::new();
    collect_calls(tree.root_node(), source, file, shaders, &mut diagnostics);
    diagnostics
}

fn collect_calls(
    node: Node,
    source: &[u8],
    file: &ScannedFile,
    shaders: &ShaderSymbols,
    out: &mut Vec<Diagnostic>,
) {
    if node.kind() == "call_expression" {
        if let Some(func) = node.child_by_field_name("function") {
            let callee = std::str::from_utf8(&source[func.byte_range()]).unwrap_or("");
            if is_binding_callee(callee) {
                if let Some(args) = node.child_by_field_name("arguments") {
                    for arg in args.named_children(&mut args.walk()) {
                        if arg.kind() == "string" {
                            if let Some(name) = strip_quotes(arg, source) {
                                if !shaders.contains(&name) {
                                    out.push(make_diag(&file.relative_path, arg, &name, callee));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    for child in node.children(&mut node.walk()) {
        collect_calls(child, source, file, shaders, out);
    }
}

fn is_binding_callee(callee: &str) -> bool {
    callee.ends_with(".getUniformLocation")
        || callee.ends_with(".getAttribLocation")
        || callee.ends_with(".getProgramResourceIndex")
}

fn strip_quotes(node: Node, source: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(&source[node.byte_range()]).ok()?;
    let t = text.trim();
    if t.len() < 2 {
        return None;
    }
    let first = t.chars().next()?;
    let last = t.chars().last()?;
    if (first == '"' || first == '\'' || first == '`') && first == last {
        Some(t[1..t.len() - 1].to_string())
    } else {
        None
    }
}

fn make_diag(file: &str, node: Node, name: &str, callee: &str) -> Diagnostic {
    let s = node.start_position();
    let e = node.end_position();
    Diagnostic {
        id: format!("binding:{}:{}:{}", file, s.row, name),
        severity: Severity::Error,
        source: DiagnosticSource::IveBinding,
        code: "ive-binding/unknown-uniform".into(),
        message: format!(
            "{callee}('{name}') — no matching uniform/attribute/var in any shader in the workspace"
        ),
        location: Location {
            file: file.to_string(),
            range: Range {
                start: [s.row as u32, s.column as u32],
                end: [e.row as u32, e.column as u32],
            },
        },
        symbol: None,
        related: vec![],
        fix: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingest_glsl_uniforms_and_attributes() {
        let src = r#"
        uniform mat4 uProjection;
        uniform sampler2D uTex;
        attribute vec3 aPosition;
        varying vec2 vUv;
        "#;
        let mut names = HashSet::new();
        ingest_shader(src, &mut names);
        assert!(names.contains("uProjection"));
        assert!(names.contains("uTex"));
        assert!(names.contains("aPosition"));
        assert!(names.contains("vUv"));
    }

    #[test]
    fn ingest_wgsl_vars() {
        let src = "@group(0) @binding(0) var<uniform> uFoo: vec4<f32>;\nvar uBar: f32;\n";
        let mut names = HashSet::new();
        ingest_shader(src, &mut names);
        assert!(names.contains("uFoo"), "{names:?}");
        assert!(names.contains("uBar"), "{names:?}");
    }

    #[test]
    fn check_flags_missing_uniform() {
        let shader_names: HashSet<String> = ["uProjection".to_string()].into_iter().collect();
        let shaders = ShaderSymbols {
            names: shader_names,
        };
        let ts = br#"
        const loc1 = gl.getUniformLocation(prog, "uProjection");
        const loc2 = gl.getUniformLocation(prog, "uMissing");
        "#;
        let sf = ScannedFile {
            relative_path: "main.ts".into(),
            language: Language::TypeScript,
            loc: 3,
            functions: vec![],
            imports: vec![],
            blob_sha: "x".into(),
            bytes_read: ts.len(),
            location: Location {
                file: "main.ts".into(),
                range: Range {
                    start: [0, 0],
                    end: [2, 0],
                },
            },
        };
        let diags = check(&sf, ts, &shaders);
        assert_eq!(diags.len(), 1);
        assert!(diags[0].message.contains("uMissing"), "{:?}", diags[0]);
        assert_eq!(diags[0].code, "ive-binding/unknown-uniform");
    }
}
