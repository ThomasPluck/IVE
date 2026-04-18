//! Workstream F — cross-file API mismatch check (arity only in v1).
//!
//! Without LSP types we can still catch the most common AI-slop shape: a
//! call site with the wrong number of positional arguments. The check works
//! from the tree-sitter AST:
//!
//! 1. Collect every exported function definition in the workspace with its
//!    declared arity (min required, max accepted, variadic flag).
//! 2. For each call site whose callee name matches a single, unambiguous
//!    workspace definition, compare argc against the declared arity.
//! 3. On mismatch, emit `ive-crossfile/arity-mismatch` as an `error`.
//!
//! Ambiguity (same name defined in multiple files / classes) disables the
//! check for that name — false positives are more expensive than misses, per
//! the spec's "grounded or no summaries" principle.
//!
//! When workstream D lands, the same file is the right place to add
//! type-based parameter checks using the Pyright/tsc hover map.

use crate::contracts::{Diagnostic, DiagnosticSource, Location, Range, Severity};
use crate::parser::Language;
use crate::scanner::ScannedFile;
use std::collections::HashMap;
use tree_sitter::Node;

#[derive(Debug, Clone, Copy)]
pub struct Arity {
    pub min: u32,
    pub max: u32, // u32::MAX if variadic
}

#[derive(Debug, Clone)]
pub struct DefSite {
    pub arity: Arity,
    pub location: Location,
}

#[derive(Debug, Default)]
pub struct DefIndex {
    by_name: HashMap<String, Vec<DefSite>>,
}

impl DefIndex {
    pub fn insert(&mut self, name: String, site: DefSite) {
        self.by_name.entry(name).or_default().push(site);
    }

    /// Returns the unambiguous definition for `name`, or None if ambiguous or
    /// missing.
    pub fn unambiguous(&self, name: &str) -> Option<&DefSite> {
        let v = self.by_name.get(name)?;
        if v.len() == 1 {
            Some(&v[0])
        } else {
            None
        }
    }

    pub fn len(&self) -> usize {
        self.by_name.values().map(|v| v.len()).sum()
    }
}

pub fn build_def_index(root: &std::path::Path, files: &HashMap<String, ScannedFile>) -> DefIndex {
    let mut idx = DefIndex::default();
    for file in files.values() {
        let abs = root.join(&file.relative_path);
        let bytes = match std::fs::read(&abs) {
            Ok(b) => b,
            Err(_) => continue,
        };
        extract_definitions(file.language, &file.relative_path, &bytes, &mut idx);
    }
    idx
}

/// The walker used by the integration test path — takes bytes directly so
/// tests don't need to hit disk.
pub fn extract_definitions(lang: Language, file: &str, source: &[u8], idx: &mut DefIndex) {
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&lang.ts_language()).is_err() {
        return;
    }
    let Some(tree) = parser.parse(source, None) else {
        return;
    };
    let root = tree.root_node();
    walk_defs(lang, root, source, file, idx);
}

fn walk_defs(lang: Language, node: Node, source: &[u8], file: &str, idx: &mut DefIndex) {
    match lang {
        Language::Python => walk_py_defs(node, source, file, idx),
        Language::TypeScript | Language::Tsx => walk_ts_defs(node, source, file, idx),
        Language::Rust => {
            // Cross-file arity for Rust defers to workstream D (rust-analyzer)
            // — the surface-level arity check here can't see method receiver
            // or generic-bound differences cleanly. No-op for now.
        }
    }
}

fn walk_py_defs(node: Node, source: &[u8], file: &str, idx: &mut DefIndex) {
    if node.kind() == "function_definition" {
        if let Some((name, arity)) = python_sig(node, source) {
            idx.insert(
                name,
                DefSite {
                    arity,
                    location: node_loc(file, node),
                },
            );
        }
    }
    for child in node.children(&mut node.walk()) {
        walk_py_defs(child, source, file, idx);
    }
}

fn python_sig(node: Node, source: &[u8]) -> Option<(String, Arity)> {
    let name_node = node.child_by_field_name("name")?;
    let name = std::str::from_utf8(&source[name_node.byte_range()])
        .ok()?
        .to_string();
    let params = node.child_by_field_name("parameters")?;
    let (mut min, mut max, mut variadic) = (0u32, 0u32, false);
    let mut cursor = params.walk();
    let mut skip_first_self = name == "__init__"; // methods: skip self
    for p in params.named_children(&mut cursor) {
        match p.kind() {
            "identifier" | "typed_parameter" => {
                if skip_first_self {
                    skip_first_self = false;
                    continue;
                }
                min += 1;
                max += 1;
            }
            "default_parameter" | "typed_default_parameter" => {
                max += 1;
            }
            "list_splat_pattern" | "tuple_pattern" | "dictionary_splat_pattern" => {
                variadic = true;
            }
            _ => {}
        }
    }
    let max_final = if variadic { u32::MAX } else { max };
    Some((
        name,
        Arity {
            min,
            max: max_final,
        },
    ))
}

fn walk_ts_defs(node: Node, source: &[u8], file: &str, idx: &mut DefIndex) {
    match node.kind() {
        "function_declaration" | "generator_function_declaration" => {
            if let Some((name, arity)) = ts_sig(node, source) {
                idx.insert(
                    name,
                    DefSite {
                        arity,
                        location: node_loc(file, node),
                    },
                );
            }
        }
        "variable_declarator" => {
            if let Some(value) = node.child_by_field_name("value") {
                if matches!(
                    value.kind(),
                    "arrow_function" | "function_expression" | "generator_function"
                ) {
                    if let (Some(name_node), Some(arity)) = (
                        node.child_by_field_name("name"),
                        ts_arity_from_formal_parameters(value, source),
                    ) {
                        if let Ok(name) = std::str::from_utf8(&source[name_node.byte_range()]) {
                            idx.insert(
                                name.to_string(),
                                DefSite {
                                    arity,
                                    location: node_loc(file, node),
                                },
                            );
                        }
                    }
                }
            }
        }
        _ => {}
    }
    for child in node.children(&mut node.walk()) {
        walk_ts_defs(child, source, file, idx);
    }
}

fn ts_sig(node: Node, source: &[u8]) -> Option<(String, Arity)> {
    let name_node = node.child_by_field_name("name")?;
    let name = std::str::from_utf8(&source[name_node.byte_range()])
        .ok()?
        .to_string();
    let arity = ts_arity_from_formal_parameters(node, source)?;
    Some((name, arity))
}

fn ts_arity_from_formal_parameters(node: Node, source: &[u8]) -> Option<Arity> {
    let params = node.child_by_field_name("parameters")?;
    let (mut min, mut max, mut variadic) = (0u32, 0u32, false);
    let mut cursor = params.walk();
    for p in params.named_children(&mut cursor) {
        let kind = p.kind();
        match kind {
            "comment" => continue,
            "optional_parameter" => {
                max += 1;
            }
            "required_parameter" => {
                // Rest: `required_parameter` wraps a `rest_pattern` child.
                let has_rest = p
                    .named_children(&mut p.walk())
                    .any(|c| c.kind() == "rest_pattern");
                if has_rest {
                    variadic = true;
                    continue;
                }
                // Default: `required_parameter` contains a `=` token child.
                let has_default = p
                    .children(&mut p.walk())
                    .any(|c| !c.is_named() && &source[c.byte_range()] == b"=");
                if has_default {
                    max += 1;
                } else {
                    min += 1;
                    max += 1;
                }
            }
            _ => {
                // Treat any other leaf shape conservatively as a required arg.
                min += 1;
                max += 1;
            }
        }
    }
    let max_final = if variadic { u32::MAX } else { max };
    Some(Arity {
        min,
        max: max_final,
    })
}

fn node_loc(file: &str, node: Node) -> Location {
    let s = node.start_position();
    let e = node.end_position();
    Location {
        file: file.to_string(),
        range: Range {
            start: [s.row as u32, s.column as u32],
            end: [e.row as u32, e.column as u32],
        },
    }
}

/// Call-site record — collected from the same parse.
#[derive(Debug, Clone)]
pub struct CallSite {
    pub callee: String,
    pub argc: u32,
    pub location: Location,
}

pub fn collect_callsites(lang: Language, file: &str, source: &[u8], out: &mut Vec<CallSite>) {
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&lang.ts_language()).is_err() {
        return;
    }
    let Some(tree) = parser.parse(source, None) else {
        return;
    };
    let mut stack = vec![tree.root_node()];
    while let Some(n) = stack.pop() {
        let call_kind = match lang {
            Language::Python => "call",
            Language::TypeScript | Language::Tsx => "call_expression",
            Language::Rust => "call_expression",
        };
        if n.kind() == call_kind {
            if let Some(site) = callsite_from_node(lang, n, source, file) {
                out.push(site);
            }
        }
        for child in n.children(&mut n.walk()) {
            stack.push(child);
        }
    }
}

fn callsite_from_node(lang: Language, n: Node, source: &[u8], file: &str) -> Option<CallSite> {
    let func = n.child_by_field_name("function")?;
    let raw = std::str::from_utf8(&source[func.byte_range()]).ok()?;
    // Only consider bare-name calls (`foo(...)`), not `obj.foo(...)` — the
    // latter needs symbol resolution we don't have until workstream D lands.
    let callee = match lang {
        Language::Python => {
            if raw.contains('.') {
                return None;
            }
            raw.to_string()
        }
        Language::TypeScript | Language::Tsx => {
            if raw.contains('.') || raw.contains('[') {
                return None;
            }
            raw.to_string()
        }
        Language::Rust => {
            // Rust cross-file arity is disabled for v1.1 (see walk_defs).
            return None;
        }
    };
    let args = n.child_by_field_name("arguments")?;
    let argc = args
        .named_children(&mut args.walk())
        .filter(|c| c.kind() != "comment")
        .count() as u32;
    Some(CallSite {
        callee,
        argc,
        location: node_loc(file, n),
    })
}

pub fn check(file: &ScannedFile, source: &[u8], index: &DefIndex) -> Vec<Diagnostic> {
    let mut calls = Vec::new();
    collect_callsites(file.language, &file.relative_path, source, &mut calls);
    let mut diagnostics = Vec::new();
    for call in calls {
        let Some(def) = index.unambiguous(&call.callee) else {
            continue;
        };
        if call.argc < def.arity.min || (def.arity.max != u32::MAX && call.argc > def.arity.max) {
            let msg = format!(
                "arity mismatch: {}() expects {}..{} args, called with {}",
                call.callee,
                def.arity.min,
                if def.arity.max == u32::MAX {
                    "∞".into()
                } else {
                    def.arity.max.to_string()
                },
                call.argc,
            );
            diagnostics.push(Diagnostic {
                id: format!(
                    "crossfile-arity:{}:{}:{}:{}",
                    file.relative_path,
                    call.location.range.start[0],
                    call.location.range.start[1],
                    call.callee,
                ),
                severity: Severity::Error,
                source: DiagnosticSource::IveCrossfile,
                code: "ive-crossfile/arity-mismatch".into(),
                message: msg,
                location: call.location,
                symbol: None,
                related: vec![crate::contracts::RelatedInfo {
                    location: def.location.clone(),
                    message: "function defined here".into(),
                }],
                fix: None,
            });
        }
    }
    diagnostics
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_arity_mismatch_is_flagged() {
        let lib = b"def f(a, b):\n    return a + b\n";
        let call = b"def g():\n    return f(1)\n";
        let mut idx = DefIndex::default();
        extract_definitions(Language::Python, "lib.py", lib, &mut idx);
        let sf = crate::scanner::ScannedFile {
            relative_path: "main.py".into(),
            language: Language::Python,
            loc: 2,
            functions: vec![],
            imports: vec![],
            blob_sha: "x".into(),
            bytes_read: call.len(),
            location: Location {
                file: "main.py".into(),
                range: Range {
                    start: [0, 0],
                    end: [1, 0],
                },
            },
        };
        let diags = check(&sf, call, &idx);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].code, "ive-crossfile/arity-mismatch");
        assert!(diags[0].message.contains("f()"));
        assert!(diags[0].message.contains("expects 2..2"));
    }

    #[test]
    fn python_default_arg_accepts_lower_argc() {
        let lib = b"def f(a, b=1):\n    return a + b\n";
        let call = b"def g():\n    return f(5)\n";
        let mut idx = DefIndex::default();
        extract_definitions(Language::Python, "lib.py", lib, &mut idx);
        let sf = make_scanned("main.py", Language::Python, call.len());
        let diags = check(&sf, call, &idx);
        assert!(
            diags.is_empty(),
            "defaults must satisfy the min-arity: {:?}",
            diags
        );
    }

    #[test]
    fn python_variadic_accepts_any_count() {
        let lib = b"def f(*args):\n    return args\n";
        let call = b"def g():\n    return f(1, 2, 3, 4, 5)\n";
        let mut idx = DefIndex::default();
        extract_definitions(Language::Python, "lib.py", lib, &mut idx);
        let sf = make_scanned("main.py", Language::Python, call.len());
        assert!(check(&sf, call, &idx).is_empty());
    }

    #[test]
    fn ambiguous_names_silence_the_check() {
        // If `f` is defined in two places, we can't be sure which is called.
        let lib_a = b"def f(a):\n    return a\n";
        let lib_b = b"def f(a, b, c):\n    return a\n";
        let mut idx = DefIndex::default();
        extract_definitions(Language::Python, "a.py", lib_a, &mut idx);
        extract_definitions(Language::Python, "b.py", lib_b, &mut idx);
        let call = b"def g():\n    return f(1, 2)\n";
        let sf = make_scanned("main.py", Language::Python, call.len());
        assert!(check(&sf, call, &idx).is_empty());
    }

    #[test]
    fn typescript_arity_mismatch_is_flagged() {
        let lib = b"export function add(a: number, b: number) { return a + b; }\n";
        let call = b"add(1);\n";
        let mut idx = DefIndex::default();
        extract_definitions(Language::TypeScript, "lib.ts", lib, &mut idx);
        let sf = make_scanned("main.ts", Language::TypeScript, call.len());
        let diags = check(&sf, call, &idx);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].code, "ive-crossfile/arity-mismatch");
    }

    #[test]
    fn typescript_optional_param_is_accepted() {
        let lib = b"export function add(a: number, b?: number) { return a + (b ?? 0); }\n";
        let call = b"add(1);\n";
        let mut idx = DefIndex::default();
        extract_definitions(Language::TypeScript, "lib.ts", lib, &mut idx);
        let sf = make_scanned("main.ts", Language::TypeScript, call.len());
        assert!(check(&sf, call, &idx).is_empty());
    }

    #[test]
    fn method_calls_are_ignored_for_now() {
        let lib = b"def f(a):\n    return a\n";
        let call = b"def g(x):\n    return x.f(1, 2, 3)\n";
        let mut idx = DefIndex::default();
        extract_definitions(Language::Python, "lib.py", lib, &mut idx);
        let sf = make_scanned("main.py", Language::Python, call.len());
        assert!(check(&sf, call, &idx).is_empty());
    }

    fn make_scanned(path: &str, lang: Language, len: usize) -> crate::scanner::ScannedFile {
        crate::scanner::ScannedFile {
            relative_path: path.into(),
            language: lang,
            loc: 2,
            functions: vec![],
            imports: vec![],
            blob_sha: "x".into(),
            bytes_read: len,
            location: Location {
                file: path.into(),
                range: Range {
                    start: [0, 0],
                    end: [1, 0],
                },
            },
        }
    }
}
