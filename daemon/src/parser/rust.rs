//! Rust-specific extraction: `fn` items, `impl` methods, trait-associated
//! functions. Rust in v1.1 ships without PDG / slicing — this module feeds
//! the AST and call-graph side only (`spec §3`).
//!
//! Import surface: top-level `use` paths that name a first segment that
//! isn't a keyword nor a workspace-local module. v1 of the hallucination
//! check treats every `use` as referencing either (a) a workspace crate,
//! (b) a stdlib prelude module, or (c) the current crate itself; we defer
//! Cargo-based validation to a follow-up (`spec §5 F`, "Rust v1.1").

use super::{complexity, location_from_node, scip_like_id, FunctionUnit};
use tree_sitter::Node;

pub fn walk(root: Node, source: &[u8], file: &str, out: &mut Vec<FunctionUnit>) {
    walk_rec(root, source, file, &mut Vec::new(), out);
}

fn walk_rec<'a>(
    node: Node<'a>,
    source: &[u8],
    file: &str,
    scope: &mut Vec<String>,
    out: &mut Vec<FunctionUnit>,
) {
    match node.kind() {
        "function_item" | "function_signature_item" => {
            push_function(node, source, file, scope, out);
            return;
        }
        "impl_item" => {
            // impl<T> Thing<T> { fn foo() ... } — use the type name as scope.
            let scope_name = impl_scope_name(node, source);
            scope.push(scope_name);
            for child in node.children(&mut node.walk()) {
                walk_rec(child, source, file, scope, out);
            }
            scope.pop();
            return;
        }
        "trait_item" => {
            let name = node
                .child_by_field_name("name")
                .and_then(|n| std::str::from_utf8(&source[n.byte_range()]).ok())
                .unwrap_or("<trait>")
                .to_string();
            scope.push(name);
            for child in node.children(&mut node.walk()) {
                walk_rec(child, source, file, scope, out);
            }
            scope.pop();
            return;
        }
        "mod_item" => {
            let name = node
                .child_by_field_name("name")
                .and_then(|n| std::str::from_utf8(&source[n.byte_range()]).ok())
                .unwrap_or("<mod>")
                .to_string();
            scope.push(name);
            for child in node.children(&mut node.walk()) {
                walk_rec(child, source, file, scope, out);
            }
            scope.pop();
            return;
        }
        _ => {}
    }
    for child in node.children(&mut node.walk()) {
        walk_rec(child, source, file, scope, out);
    }
}

fn impl_scope_name(node: Node, source: &[u8]) -> String {
    // Prefer the `type` field of the impl (what's implemented ON).
    if let Some(t) = node.child_by_field_name("type") {
        if let Ok(text) = std::str::from_utf8(&source[t.byte_range()]) {
            return text.trim().to_string();
        }
    }
    "<impl>".to_string()
}

fn push_function(
    node: Node,
    source: &[u8],
    file: &str,
    scope: &mut Vec<String>,
    out: &mut Vec<FunctionUnit>,
) {
    let name = node
        .child_by_field_name("name")
        .and_then(|n| std::str::from_utf8(&source[n.byte_range()]).ok())
        .unwrap_or("<anon>")
        .to_string();
    let body = node.child_by_field_name("body");
    let cc = body
        .map(|b| complexity::score(complexity::Dialect::Rust, b, source))
        .unwrap_or(0);
    let loc = (node.end_position().row - node.start_position().row + 1) as u32;
    let callees = body.map(|b| collect_callees(b, source)).unwrap_or_default();
    let qualified = if scope.is_empty() {
        name.clone()
    } else {
        format!("{}::{}", scope.join("::"), name)
    };
    out.push(FunctionUnit {
        symbol_id: scip_like_id(file, &qualified),
        name: qualified.clone(),
        location: location_from_node(file, &node),
        cognitive_complexity: cc,
        loc,
        local_callees: callees,
    });

    // Descend for nested functions / closures with named bindings we treat as
    // units in their own right. For v1.1 we skip closures — they'd be noise.
    scope.push(name);
    for child in node.children(&mut node.walk()) {
        walk_rec(child, source, file, scope, out);
    }
    scope.pop();
}

fn collect_callees(body: Node, source: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![body];
    while let Some(n) = stack.pop() {
        if n.kind() == "call_expression" {
            if let Some(func) = n.child_by_field_name("function") {
                if let Ok(text) = std::str::from_utf8(&source[func.byte_range()]) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() && !out.iter().any(|c: &String| c == trimmed) {
                        out.push(trimmed.to_string());
                    }
                }
            }
        }
        // Don't descend into nested `function_item`s — they get their own unit.
        if matches!(n.kind(), "function_item" | "function_signature_item") && n.id() != body.id() {
            continue;
        }
        for child in n.children(&mut n.walk()) {
            stack.push(child);
        }
    }
    out
}

/// Top-level `use` crate references. Returns the first segment of each
/// `use` path (the external-facing crate name).
#[derive(Debug, Clone)]
pub struct UseStatement {
    pub crate_name: String,
    pub range: ([u32; 2], [u32; 2]),
}

pub fn extract_uses(source: &[u8]) -> Vec<UseStatement> {
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&tree_sitter_rust::LANGUAGE.into())
        .expect("rust");
    let Some(tree) = parser.parse(source, None) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let root = tree.root_node();
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        if child.kind() == "use_declaration" {
            let s = child.start_position();
            let e = child.end_position();
            let range = (
                [s.row as u32, s.column as u32],
                [e.row as u32, e.column as u32],
            );
            if let Some(name) = first_path_segment(child, source) {
                out.push(UseStatement {
                    crate_name: name,
                    range,
                });
            }
        }
    }
    out
}

fn first_path_segment(use_decl: Node, source: &[u8]) -> Option<String> {
    // Recurse until we hit a scoped_identifier / identifier; return the leftmost.
    let mut stack = vec![use_decl];
    while let Some(n) = stack.pop() {
        if n.kind() == "scoped_identifier" || n.kind() == "scoped_use_list" {
            if let Some(path) = n.child_by_field_name("path") {
                return first_path_segment(path, source);
            }
        }
        if n.kind() == "identifier" {
            if let Ok(text) = std::str::from_utf8(&source[n.byte_range()]) {
                return Some(text.to_string());
            }
        }
        for child in n.children(&mut n.walk()) {
            stack.push(child);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::super::{extract_functions, Language};
    use super::*;

    #[test]
    fn extracts_top_level_fn() {
        let src = "fn foo() {}\nfn bar(x: u32) -> u32 { if x == 0 { 1 } else { 0 } }\n";
        let fns = extract_functions(Language::Rust, "m.rs", src.as_bytes()).unwrap();
        assert_eq!(fns.len(), 2);
        assert_eq!(fns[0].name, "foo");
        assert_eq!(fns[1].name, "bar");
        // if/else: +1 for `if`, +1 for `else` branch
        assert!(fns[1].cognitive_complexity >= 1);
    }

    #[test]
    fn extracts_methods_on_impl_with_scope() {
        let src = r#"struct K;
impl K {
    fn m(&self) -> u32 { 1 }
}
"#;
        let fns = extract_functions(Language::Rust, "m.rs", src.as_bytes()).unwrap();
        assert_eq!(fns.len(), 1);
        assert_eq!(fns[0].name, "K::m");
    }

    #[test]
    fn extracts_trait_associated_functions() {
        let src = r#"trait T {
    fn f(&self);
}
"#;
        let fns = extract_functions(Language::Rust, "m.rs", src.as_bytes()).unwrap();
        assert_eq!(fns.len(), 1);
        assert_eq!(fns[0].name, "T::f");
    }

    #[test]
    fn use_declarations_capture_top_level_crate_name() {
        let src = "use serde::Serialize;\nuse std::collections::HashMap;\n";
        let uses = extract_uses(src.as_bytes());
        let names: Vec<_> = uses.iter().map(|u| u.crate_name.clone()).collect();
        assert_eq!(names, vec!["serde".to_string(), "std".to_string()]);
    }
}
