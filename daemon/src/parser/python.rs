//! Python-specific extraction: function definitions, qualified names, callees.

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
        "function_definition" => {
            let name = node
                .child_by_field_name("name")
                .and_then(|n| std::str::from_utf8(&source[n.byte_range()]).ok())
                .unwrap_or("<anon>")
                .to_string();
            let body = node.child_by_field_name("body");
            let cc = body
                .map(|b| complexity::score(complexity::Dialect::Python, b, source))
                .unwrap_or(0);
            let loc = (node.end_position().row - node.start_position().row + 1) as u32;
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
                location: location_from_node(file, &node),
                cognitive_complexity: cc,
                loc,
                local_callees: callees,
            });

            scope.push(name);
            for child in node.children(&mut node.walk()) {
                walk_rec(child, source, file, scope, out);
            }
            scope.pop();
        }
        "class_definition" => {
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
        }
        _ => {
            for child in node.children(&mut node.walk()) {
                walk_rec(child, source, file, scope, out);
            }
        }
    }
}

fn collect_callees(body: Node, source: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![body];
    while let Some(n) = stack.pop() {
        if n.kind() == "call" {
            if let Some(func) = n.child_by_field_name("function") {
                if let Ok(text) = std::str::from_utf8(&source[func.byte_range()]) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() && !out.iter().any(|c: &String| c == trimmed) {
                        out.push(trimmed.to_string());
                    }
                }
            }
        }
        // Don't descend into nested function/class bodies — those belong to
        // their own FunctionUnit.
        if matches!(n.kind(), "function_definition" | "class_definition") && n.id() != body.id() {
            continue;
        }
        for child in n.children(&mut n.walk()) {
            stack.push(child);
        }
    }
    out
}

/// Extract every top-level `import` / `from X import Y` module.
pub fn extract_imports(source: &[u8]) -> Vec<ImportStatement> {
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&tree_sitter_python::LANGUAGE.into())
        .expect("python");
    let Some(tree) = parser.parse(source, None) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let root = tree.root_node();
    let mut cursor = root.walk();
    for child in root.children(&mut cursor) {
        let s = child.start_position();
        let e = child.end_position();
        let range = (
            [s.row as u32, s.column as u32],
            [e.row as u32, e.column as u32],
        );
        match child.kind() {
            "import_statement" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    if let Ok(text) = std::str::from_utf8(&source[name_node.byte_range()]) {
                        let mod_ = text.split('.').next().unwrap_or(text).to_string();
                        out.push(ImportStatement {
                            module: mod_,
                            range,
                        });
                    }
                }
            }
            "import_from_statement" => {
                if let Some(mod_node) = child.child_by_field_name("module_name") {
                    if let Ok(text) = std::str::from_utf8(&source[mod_node.byte_range()]) {
                        if !text.starts_with('.') {
                            let mod_ = text.split('.').next().unwrap_or(text).to_string();
                            out.push(ImportStatement {
                                module: mod_,
                                range,
                            });
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
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
    fn extracts_top_level_functions() {
        let src = "def a():\n    return 1\n\ndef b(x):\n    if x:\n        return 2\n";
        let fns = extract_functions(Language::Python, "m.py", src.as_bytes()).unwrap();
        assert_eq!(fns.len(), 2);
        assert_eq!(fns[0].name, "a");
        assert_eq!(fns[1].name, "b");
        assert_eq!(fns[1].cognitive_complexity, 1);
    }

    #[test]
    fn extracts_class_methods_with_qualified_names() {
        let src = "class C:\n    def m(self):\n        return 1\n";
        let fns = extract_functions(Language::Python, "m.py", src.as_bytes()).unwrap();
        assert_eq!(fns.len(), 1);
        assert_eq!(fns[0].name, "C.m");
    }

    #[test]
    fn imports_skip_relative() {
        let src = "import os\nfrom . import foo\nfrom requests import get\n";
        let imports = extract_imports(src.as_bytes());
        let names: Vec<_> = imports.iter().map(|i| i.module.clone()).collect();
        assert_eq!(names, vec!["os".to_string(), "requests".to_string()]);
    }
}
