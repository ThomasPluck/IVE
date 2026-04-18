//! TypeScript/TSX-specific extraction.
//!
//! Tree-sitter identifies TS functions in a few shapes: declarations, methods,
//! arrow-bound variable declarations, and object-literal methods. We surface
//! all of them as `FunctionUnit`s.

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
        "function_declaration" | "generator_function_declaration" => {
            push_function(node, source, file, scope, out, name_of(node, source));
            return;
        }
        "method_definition" => {
            push_function(node, source, file, scope, out, name_of(node, source));
            return;
        }
        "variable_declarator" => {
            // const foo = () => ... | async function() ...
            if let Some(value) = node.child_by_field_name("value") {
                if matches!(
                    value.kind(),
                    "arrow_function" | "function_expression" | "generator_function"
                ) {
                    let name = node
                        .child_by_field_name("name")
                        .and_then(|n| std::str::from_utf8(&source[n.byte_range()]).ok())
                        .unwrap_or("<anon>")
                        .to_string();
                    push_function_with_body(node, value, source, file, scope, out, name);
                    return;
                }
            }
        }
        "class_declaration" | "class" => {
            let name = node
                .child_by_field_name("name")
                .and_then(|n| std::str::from_utf8(&source[n.byte_range()]).ok())
                .unwrap_or("<anon>")
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

fn name_of(node: Node, source: &[u8]) -> String {
    node.child_by_field_name("name")
        .and_then(|n| std::str::from_utf8(&source[n.byte_range()]).ok())
        .unwrap_or("<anon>")
        .to_string()
}

fn push_function(
    node: Node,
    source: &[u8],
    file: &str,
    scope: &mut Vec<String>,
    out: &mut Vec<FunctionUnit>,
    name: String,
) {
    push_function_with_body(node, node, source, file, scope, out, name);
}

fn push_function_with_body(
    decl_node: Node,
    body_owner: Node,
    source: &[u8],
    file: &str,
    scope: &mut Vec<String>,
    out: &mut Vec<FunctionUnit>,
    name: String,
) {
    let body = body_owner
        .child_by_field_name("body")
        .or_else(|| last_child_kind(body_owner, "statement_block"));
    let cc = body
        .map(|b| complexity::score(complexity::Dialect::TypeScript, b, source))
        .unwrap_or(0);
    let loc = (decl_node.end_position().row - decl_node.start_position().row + 1) as u32;
    let callees = if let Some(b) = body {
        collect_callees(b, source)
    } else {
        Vec::new()
    };
    let qualified = if scope.is_empty() {
        name.clone()
    } else {
        format!("{}.{}", scope.join("."), name)
    };
    out.push(FunctionUnit {
        symbol_id: scip_like_id(file, &qualified),
        name: qualified.clone(),
        location: location_from_node(file, &decl_node),
        cognitive_complexity: cc,
        loc,
        local_callees: callees,
    });

    scope.push(name);
    if let Some(b) = body {
        for child in b.children(&mut b.walk()) {
            walk_rec(child, source, file, scope, out);
        }
    }
    scope.pop();
}

fn last_child_kind<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
    let mut found = None;
    for child in node.children(&mut node.walk()) {
        if child.kind() == kind {
            found = Some(child);
        }
    }
    found
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
        // Don't descend into nested function bodies — they get their own units.
        if matches!(
            n.kind(),
            "function_declaration"
                | "function_expression"
                | "arrow_function"
                | "method_definition"
                | "generator_function_declaration"
                | "generator_function"
        ) && n.id() != body.id()
        {
            continue;
        }
        for child in n.children(&mut n.walk()) {
            stack.push(child);
        }
    }
    out
}

/// Extract module specifiers from import / require / dynamic-import statements.
pub fn extract_imports(source: &[u8], is_tsx: bool) -> Vec<ImportStatement> {
    let mut parser = tree_sitter::Parser::new();
    let lang = if is_tsx {
        tree_sitter_typescript::LANGUAGE_TSX.into()
    } else {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
    };
    parser.set_language(&lang).expect("typescript");
    let Some(tree) = parser.parse(source, None) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut stack = vec![tree.root_node()];
    while let Some(n) = stack.pop() {
        if n.kind() == "import_statement" {
            if let Some(source_node) = n.child_by_field_name("source") {
                if let Some(spec) = string_literal_text(source_node, source) {
                    let s = n.start_position();
                    let e = n.end_position();
                    out.push(ImportStatement {
                        module: spec,
                        range: (
                            [s.row as u32, s.column as u32],
                            [e.row as u32, e.column as u32],
                        ),
                    });
                }
            }
        } else if n.kind() == "call_expression" {
            if let Some(callee) = n.child_by_field_name("function") {
                let name = std::str::from_utf8(&source[callee.byte_range()]).unwrap_or("");
                if name == "require" || name == "import" {
                    if let Some(args) = n.child_by_field_name("arguments") {
                        for arg in args.children(&mut args.walk()) {
                            if let Some(spec) = string_literal_text(arg, source) {
                                let s = n.start_position();
                                let e = n.end_position();
                                out.push(ImportStatement {
                                    module: spec,
                                    range: (
                                        [s.row as u32, s.column as u32],
                                        [e.row as u32, e.column as u32],
                                    ),
                                });
                            }
                        }
                    }
                }
            }
        }
        for child in n.children(&mut n.walk()) {
            stack.push(child);
        }
    }
    out
}

fn string_literal_text(node: Node, source: &[u8]) -> Option<String> {
    if node.kind() != "string" {
        return None;
    }
    let text = std::str::from_utf8(&source[node.byte_range()]).ok()?;
    let trimmed = text.trim();
    if trimmed.len() < 2 {
        return None;
    }
    let first = trimmed.chars().next().unwrap();
    let last = trimmed.chars().last().unwrap();
    if (first == '"' || first == '\'' || first == '`') && first == last {
        Some(trimmed[1..trimmed.len() - 1].to_string())
    } else {
        None
    }
}

#[derive(Debug, Clone)]
pub struct ImportStatement {
    pub module: String,
    pub range: ([u32; 2], [u32; 2]),
}

#[cfg(test)]
mod tests {
    use super::super::{extract_functions, Language};
    use super::*;

    #[test]
    fn extracts_function_declaration() {
        let src = "function foo(x: number) { if (x > 0) return x; return 0; }";
        let fns = extract_functions(Language::TypeScript, "m.ts", src.as_bytes()).unwrap();
        assert_eq!(fns.len(), 1);
        assert_eq!(fns[0].name, "foo");
        assert_eq!(fns[0].cognitive_complexity, 1);
    }

    #[test]
    fn extracts_arrow_functions_bound_to_const() {
        let src = "const bar = (x: number) => { if (x) return 1; else return 2; };";
        let fns = extract_functions(Language::TypeScript, "m.ts", src.as_bytes()).unwrap();
        assert_eq!(fns.len(), 1);
        assert_eq!(fns[0].name, "bar");
    }

    #[test]
    fn extracts_method_inside_class() {
        let src = "class K { m(x: number) { return x; } }";
        let fns = extract_functions(Language::TypeScript, "m.ts", src.as_bytes()).unwrap();
        assert_eq!(fns.len(), 1);
        assert_eq!(fns[0].name, "K.m");
    }

    #[test]
    fn imports_capture_specifiers() {
        let src = "import x from 'foo';\nimport { y } from \"bar\";\nconst z = require('baz');\n";
        let imports = extract_imports(src.as_bytes(), false);
        let mods: Vec<_> = imports.iter().map(|i| i.module.clone()).collect();
        assert!(mods.contains(&"foo".to_string()));
        assert!(mods.contains(&"bar".to_string()));
        assert!(mods.contains(&"baz".to_string()));
    }
}
