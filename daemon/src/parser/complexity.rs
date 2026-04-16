//! Cognitive complexity per Campbell 2017 (SonarSource).
//!
//! Rules implemented, per `spec §6`:
//! - `+1` for every break in linear flow: if/elif/else-if, for, while, catch,
//!   switch (on each case of the switch head), ternary, `goto`-like breaks.
//! - `+nesting_level` extra on the same nodes when they are themselves nested
//!   inside another control-flow node.
//! - Short-circuit sequences (`and`/`or`, `&&`/`||`) add `+1` **only** when
//!   the operator changes from the previous one in the same flat chain.
//! - Recursion is not scored in v1 (requires cross-file call resolution —
//!   see workstream F).
//!
//! The implementation is a node-kind visitor so it works for any tree-sitter
//! grammar with a matching kind table.

use tree_sitter::Node;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Python,
    TypeScript,
}

struct Kinds {
    /// Nodes that count as +1 and increase nesting.
    flow: &'static [&'static str],
    /// Same-body short-circuit operator nodes.
    boolean_binary: &'static [&'static str],
    /// Function/method bodies — entering one resets nesting to 0.
    function_like: &'static [&'static str],
    /// `else` / `elif` branches: count as +1 without extra nesting increment.
    else_like: &'static [&'static str],
    /// Jump-out-of-flow keywords that count as +1 when non-trivially nested.
    abrupt_jump: &'static [&'static str],
}

impl Kinds {
    fn for_dialect(d: Dialect) -> Self {
        match d {
            Dialect::Python => Self {
                flow: &[
                    "if_statement",
                    "for_statement",
                    "while_statement",
                    "except_clause",
                    "match_statement",
                    "case_clause",
                    "conditional_expression", // ternary
                ],
                boolean_binary: &["boolean_operator"],
                function_like: &["function_definition", "lambda"],
                else_like: &["elif_clause", "else_clause"],
                abrupt_jump: &["break_statement", "continue_statement", "raise_statement"],
            },
            Dialect::TypeScript => Self {
                flow: &[
                    "if_statement",
                    "for_statement",
                    "for_in_statement",
                    "while_statement",
                    "do_statement",
                    "catch_clause",
                    "switch_statement",
                    "ternary_expression",
                ],
                boolean_binary: &["binary_expression"],
                function_like: &[
                    "function_declaration",
                    "function_expression",
                    "arrow_function",
                    "method_definition",
                    "generator_function",
                    "generator_function_declaration",
                ],
                else_like: &["else_clause"],
                abrupt_jump: &["break_statement", "continue_statement", "throw_statement"],
            },
        }
    }
}

/// Score a subtree rooted at `root` treated as the body of a single function.
pub fn score(dialect: Dialect, root: Node, source: &[u8]) -> u32 {
    let kinds = Kinds::for_dialect(dialect);
    let mut score = 0u32;
    visit(root, source, &kinds, 0, &mut score, None);
    score
}

fn visit(
    node: Node,
    source: &[u8],
    kinds: &Kinds,
    nesting: u32,
    out: &mut u32,
    parent_bool_op: Option<&str>,
) {
    let kind = node.kind();

    // Descending into a nested function resets the nesting counter — we score
    // each function independently. The outer caller stops at the outer
    // function boundary, so if we re-enter here, treat the new function as
    // a fresh root.
    if kinds.function_like.contains(&kind) && node.parent().is_some() {
        return;
    }

    let mut next_nesting = nesting;

    if kinds.flow.contains(&kind) {
        *out += 1 + nesting;
        next_nesting = nesting + 1;
    } else if kinds.else_like.contains(&kind) {
        // else/elif: +1 flat, no nesting bump
        *out += 1;
    } else if kinds.abrupt_jump.contains(&kind) && nesting > 0 {
        *out += 1;
    }

    // Short-circuit operator chains: +1 only when operator kind changes.
    if kinds.boolean_binary.contains(&kind) {
        // For Python it's always boolean_operator; for TS we need to check the
        // operator text and only score `&&`/`||`.
        let op = operator_text(node, source);
        let is_short_circuit = matches!(op.as_deref(), Some("&&") | Some("||") | Some("and") | Some("or"));
        if is_short_circuit {
            let changed = parent_bool_op != op.as_deref();
            if changed {
                *out += 1;
            }
            for child in node.children(&mut node.walk()) {
                visit(child, source, kinds, next_nesting, out, op.as_deref());
            }
            return;
        }
    }

    for child in node.children(&mut node.walk()) {
        visit(child, source, kinds, next_nesting, out, None);
    }
}

fn operator_text(node: Node, source: &[u8]) -> Option<String> {
    // Try an "operator" field first, then scan children for a likely operator.
    if let Some(op) = node.child_by_field_name("operator") {
        return std::str::from_utf8(&source[op.byte_range()]).ok().map(str::to_string);
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        let text = std::str::from_utf8(&source[child.byte_range()]).unwrap_or("");
        if text == "&&" || text == "||" || text == "and" || text == "or" {
            return Some(text.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn py_score(src: &str) -> u32 {
        let mut p = Parser::new();
        p.set_language(&tree_sitter_python::LANGUAGE.into()).unwrap();
        let t = p.parse(src, None).unwrap();
        // Find the first function body node in the root.
        let mut cursor = t.root_node().walk();
        for child in t.root_node().children(&mut cursor) {
            if child.kind() == "function_definition" {
                if let Some(body) = child.child_by_field_name("body") {
                    return score(Dialect::Python, body, src.as_bytes());
                }
            }
        }
        score(Dialect::Python, t.root_node(), src.as_bytes())
    }

    #[test]
    fn flat_function_scores_zero() {
        let src = "def f():\n    return 1\n";
        assert_eq!(py_score(src), 0);
    }

    #[test]
    fn single_if_scores_one() {
        let src = "def f(x):\n    if x:\n        return 1\n";
        assert_eq!(py_score(src), 1);
    }

    #[test]
    fn nested_if_adds_extra_for_nesting() {
        let src = "def f(x, y):\n    if x:\n        if y:\n            return 1\n";
        // outer if: +1, inner if: +1 (self) + +1 (nesting) = 2 → total 3
        assert_eq!(py_score(src), 3);
    }
}
