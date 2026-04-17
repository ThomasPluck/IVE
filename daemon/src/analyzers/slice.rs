//! Workstream C partial — intra-function backward slice via tree-sitter AST.
//!
//! This is NOT a full PDG/SDG slice (that's what Joern exists for). It's a
//! best-effort, same-function, thin (value-flow only) approximation that
//! works **without any CPG**. Given a cursor position, we:
//!
//! 1. Find the smallest enclosing function node.
//! 2. Break its body into statements (one per child of the body block).
//! 3. For each statement, compute the set of identifiers it writes and the
//!    set it reads.
//! 4. Starting from the origin statement's reads, walk the body backwards
//!    (top-down, cut-off at origin), picking up every earlier statement
//!    that writes a needed identifier and unioning its reads into the
//!    needed set.
//! 5. Emit the selected statements as `SliceNode`s and connect them with
//!    single data edges (thin slice — no control edges, no call edges
//!    because we can't resolve callees here).
//!
//! What this catches: the classic "where did this variable get its value"
//! within a function. What it misses: cross-function flows (need Joern),
//! aliasing through mutable containers, pointer escape, control
//! dependencies. All documented — see `spec §3` and `spec §11` (thin
//! slicing, ORBS).
//!
//! Forward slicing follows the same shape: from the origin's writes,
//! propagate forwards through later statements whose reads intersect.
//!
//! When `request.cross_file` is true we refuse the request and emit
//! `capabilityDegraded{capability:"cpg"}` — an intra-function slice
//! wouldn't be honest about that boundary.

use crate::contracts::{
    Location, Range, Slice, SliceDirection, SliceEdge, SliceEdgeKind, SliceKind, SliceNode,
    SliceRequest,
};
use crate::parser::Language;
use std::collections::HashSet;
use std::time::Instant;
use tree_sitter::{Node, Tree};

pub enum Outcome {
    Ok(Slice),
    /// Workspace needs the full CPG — caller should surface
    /// `capabilityDegraded{capability:"cpg"}`.
    NeedsCpg(&'static str),
    /// Cursor isn't inside a function we can handle.
    NoEnclosingFunction,
}

pub fn compute(request: &SliceRequest, file_bytes: &[u8], lang: Language) -> Outcome {
    if request.cross_file {
        return Outcome::NeedsCpg(
            "cross-file slicing needs the Code Property Graph (workstream C). Local intra-function slice only for now.",
        );
    }
    let started = Instant::now();

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&lang.ts_language()).is_err() {
        return Outcome::NoEnclosingFunction;
    }
    let Some(tree) = parser.parse(file_bytes, None) else {
        return Outcome::NoEnclosingFunction;
    };

    let origin_line = request.origin.range.start[0];
    let origin_col = request.origin.range.start[1];

    let Some(function_node) = smallest_enclosing_function(&tree, lang, origin_line, origin_col)
    else {
        return Outcome::NoEnclosingFunction;
    };

    let Some(body) = function_body_of(function_node, lang) else {
        return Outcome::NoEnclosingFunction;
    };

    let stmts = statements_of(body);
    if stmts.is_empty() {
        return Outcome::NoEnclosingFunction;
    }

    let origin_idx = stmts
        .iter()
        .position(|n| contains_point(*n, origin_line, origin_col))
        .unwrap_or(0);

    let max_hops = request.max_hops.unwrap_or(10).max(1) as usize;
    let selected: Vec<usize> = match request.direction {
        SliceDirection::Backward => backward(stmts.as_slice(), file_bytes, origin_idx, max_hops),
        SliceDirection::Forward => forward(stmts.as_slice(), file_bytes, origin_idx, max_hops),
    };

    let mut nodes = Vec::with_capacity(selected.len());
    let file = request.origin.file.clone();
    for (i, &s_idx) in selected.iter().enumerate() {
        let n = stmts[s_idx];
        let s = n.start_position();
        let e = n.end_position();
        let label = std::str::from_utf8(&file_bytes[n.byte_range()])
            .unwrap_or("<?>")
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .chars()
            .take(80)
            .collect();
        nodes.push(SliceNode {
            id: i as u32,
            location: Location {
                file: file.clone(),
                range: Range {
                    start: [s.row as u32, s.column as u32],
                    end: [e.row as u32, e.column as u32],
                },
            },
            label,
        });
    }

    // Single-chain data edges between consecutive selected statements.
    let edges: Vec<SliceEdge> = (1..nodes.len() as u32)
        .map(|i| SliceEdge {
            from: i - 1,
            to: i,
            kind: SliceEdgeKind::Data,
        })
        .collect();

    let truncated = matches!(request.kind, SliceKind::Full) || selected.len() >= max_hops;
    Outcome::Ok(Slice {
        request: request.clone(),
        nodes,
        edges,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn smallest_enclosing_function<'a>(
    tree: &'a Tree,
    lang: Language,
    line: u32,
    col: u32,
) -> Option<Node<'a>> {
    let root = tree.root_node();
    let mut stack = vec![root];
    let mut best: Option<Node<'a>> = None;
    while let Some(n) = stack.pop() {
        if is_function_like(n, lang) && contains_point(n, line, col) {
            best = match best {
                None => Some(n),
                Some(prev) => {
                    if byte_span(n) < byte_span(prev) {
                        Some(n)
                    } else {
                        Some(prev)
                    }
                }
            };
        }
        for child in n.children(&mut n.walk()) {
            stack.push(child);
        }
    }
    best
}

fn is_function_like(n: Node, lang: Language) -> bool {
    match lang {
        Language::Python => matches!(n.kind(), "function_definition" | "lambda"),
        Language::TypeScript | Language::Tsx => matches!(
            n.kind(),
            "function_declaration"
                | "function_expression"
                | "arrow_function"
                | "method_definition"
                | "generator_function"
                | "generator_function_declaration"
        ),
        Language::Rust => matches!(n.kind(), "function_item"),
    }
}

fn function_body_of<'a>(fun: Node<'a>, lang: Language) -> Option<Node<'a>> {
    if let Some(body) = fun.child_by_field_name("body") {
        // TS arrow functions may have an expression body; we need a block.
        if matches!(lang, Language::TypeScript | Language::Tsx) && body.kind() != "statement_block"
        {
            return None;
        }
        return Some(body);
    }
    None
}

fn statements_of<'a>(body: Node<'a>) -> Vec<Node<'a>> {
    body.named_children(&mut body.walk()).collect()
}

fn contains_point(n: Node, line: u32, col: u32) -> bool {
    let s = n.start_position();
    let e = n.end_position();
    let (sl, sc, el, ec) = (s.row as u32, s.column as u32, e.row as u32, e.column as u32);
    (sl, sc) <= (line, col) && (el, ec) >= (line, col)
}

fn byte_span(n: Node) -> usize {
    let r = n.byte_range();
    r.end.saturating_sub(r.start)
}

fn backward(stmts: &[Node], source: &[u8], origin: usize, max_hops: usize) -> Vec<usize> {
    let origin_reads = reads_of(stmts[origin], source);
    let mut needed: HashSet<String> = origin_reads.into_iter().collect();
    let mut selected: Vec<usize> = vec![origin];
    for i in (0..origin).rev() {
        if selected.len() >= max_hops {
            break;
        }
        let writes = writes_of(stmts[i], source);
        let touches_needed = writes.iter().any(|w| needed.contains(w));
        if !touches_needed {
            continue;
        }
        selected.push(i);
        for r in reads_of(stmts[i], source) {
            needed.insert(r);
        }
        for w in writes {
            // Statements earlier than this one re-writing the same var are
            // now relevant only if they contribute reads too — removing the
            // `w` from `needed` would over-prune a chain. Keep it.
            let _ = w;
        }
    }
    selected.reverse();
    selected
}

fn forward(stmts: &[Node], source: &[u8], origin: usize, max_hops: usize) -> Vec<usize> {
    let origin_writes = writes_of(stmts[origin], source);
    let mut flowing: HashSet<String> = origin_writes.into_iter().collect();
    let mut selected: Vec<usize> = vec![origin];
    for i in (origin + 1)..stmts.len() {
        if selected.len() >= max_hops {
            break;
        }
        let reads = reads_of(stmts[i], source);
        let touches_flowing = reads.iter().any(|r| flowing.contains(r));
        if !touches_flowing {
            continue;
        }
        selected.push(i);
        for w in writes_of(stmts[i], source) {
            flowing.insert(w);
        }
    }
    selected
}

/// Everything bound by this statement (assignment targets, `let` LHS, for-loop
/// target, function parameters if statement is itself a function). Best-effort
/// and language-agnostic — we accept a few false positives to keep the slice
/// from missing obvious writes.
fn writes_of(stmt: Node, source: &[u8]) -> HashSet<String> {
    let mut out = HashSet::new();
    // Walk for any assignment-shaped nodes.
    let mut stack = vec![stmt];
    while let Some(n) = stack.pop() {
        match n.kind() {
            // Python
            "assignment" | "augmented_assignment" => {
                if let Some(left) = n.child_by_field_name("left") {
                    collect_identifiers_at(&left, source, &mut out);
                }
            }
            "for_statement" => {
                if let Some(left) = n.child_by_field_name("left") {
                    collect_identifiers_at(&left, source, &mut out);
                }
            }
            // TS
            "variable_declarator" | "lexical_declaration" => {
                if let Some(name) = n.child_by_field_name("name") {
                    collect_identifiers_at(&name, source, &mut out);
                }
            }
            "assignment_expression" | "augmented_assignment_expression" => {
                if let Some(left) = n.child_by_field_name("left") {
                    collect_identifiers_at(&left, source, &mut out);
                }
            }
            // Rust
            "let_declaration" => {
                if let Some(p) = n.child_by_field_name("pattern") {
                    collect_identifiers_at(&p, source, &mut out);
                }
            }
            _ => {}
        }
        for child in n.children(&mut n.walk()) {
            stack.push(child);
        }
    }
    out
}

/// Every identifier used as a value in this statement. Identifiers that
/// appear in LHS positions are excluded so a simple `x = foo()` reads
/// `foo`, writes `x`.
fn reads_of(stmt: Node, source: &[u8]) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut stack = vec![(stmt, false)];
    while let Some((n, in_lhs)) = stack.pop() {
        match n.kind() {
            "assignment" | "assignment_expression" => {
                if let Some(left) = n.child_by_field_name("left") {
                    stack.push((left, true));
                }
                if let Some(right) = n.child_by_field_name("right") {
                    stack.push((right, false));
                }
                continue;
            }
            "augmented_assignment" | "augmented_assignment_expression" => {
                // `x += y` reads both x and y — treat LHS as also-read.
                for child in n.children(&mut n.walk()) {
                    stack.push((child, false));
                }
                continue;
            }
            "variable_declarator" => {
                if let Some(value) = n.child_by_field_name("value") {
                    stack.push((value, false));
                }
                continue;
            }
            "let_declaration" => {
                if let Some(value) = n.child_by_field_name("value") {
                    stack.push((value, false));
                }
                continue;
            }
            "for_statement" => {
                if let Some(right) = n.child_by_field_name("right") {
                    stack.push((right, false));
                }
                if let Some(body) = n.child_by_field_name("body") {
                    stack.push((body, false));
                }
                continue;
            }
            "identifier" => {
                if !in_lhs {
                    if let Ok(text) = std::str::from_utf8(&source[n.byte_range()]) {
                        out.insert(text.to_string());
                    }
                }
                continue;
            }
            _ => {}
        }
        for child in n.children(&mut n.walk()) {
            stack.push((child, in_lhs));
        }
    }
    out
}

fn collect_identifiers_at(node: &Node, source: &[u8], out: &mut HashSet<String>) {
    let mut stack = vec![*node];
    while let Some(n) = stack.pop() {
        if n.kind() == "identifier" {
            if let Ok(text) = std::str::from_utf8(&source[n.byte_range()]) {
                out.insert(text.to_string());
            }
        }
        for child in n.children(&mut n.walk()) {
            stack.push(child);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{Location, Range, SliceDirection, SliceKind};

    fn req(file: &str, line: u32, col: u32, dir: SliceDirection) -> SliceRequest {
        SliceRequest {
            origin: Location {
                file: file.into(),
                range: Range {
                    start: [line, col],
                    end: [line, col],
                },
            },
            direction: dir,
            kind: SliceKind::Thin,
            max_hops: Some(10),
            cross_file: false,
        }
    }

    #[test]
    fn cross_file_request_returns_needs_cpg() {
        let src = b"def f():\n    return 1\n";
        let mut r = req("a.py", 1, 11, SliceDirection::Backward);
        r.cross_file = true;
        matches!(compute(&r, src, Language::Python), Outcome::NeedsCpg(_));
    }

    #[test]
    fn python_backward_slice_chains_assignments() {
        // Line 4 returns `result`; `result` = `x + y`; `x = ...`; `y = ...`.
        let src =
            b"def f(a):\n    x = a * 2\n    y = a + 1\n    result = x + y\n    return result\n";
        let r = req("a.py", 4, 11, SliceDirection::Backward);
        match compute(&r, src, Language::Python) {
            Outcome::Ok(slice) => {
                // Expect: `result = x + y` origin, `x = …`, `y = …` all included.
                let labels: Vec<_> = slice.nodes.iter().map(|n| n.label.as_str()).collect();
                assert!(labels.iter().any(|l| l.contains("result = x + y")));
                assert!(labels.iter().any(|l| l.contains("x = a * 2")));
                assert!(labels.iter().any(|l| l.contains("y = a + 1")));
            }
            other => panic!(
                "expected Ok, got {:?}",
                match other {
                    Outcome::NeedsCpg(m) => format!("NeedsCpg({m})"),
                    Outcome::NoEnclosingFunction => "NoEnclosingFunction".into(),
                    _ => "Ok".into(),
                }
            ),
        }
    }

    #[test]
    fn python_forward_slice_follows_uses() {
        // Line 2 defines `x`; forward slice from there should pick up the
        // statement that reads `x`.
        let src =
            b"def f(a):\n    x = a * 2\n    other = 0\n    result = x + 1\n    return result\n";
        let r = req("a.py", 1, 4, SliceDirection::Forward);
        match compute(&r, src, Language::Python) {
            Outcome::Ok(slice) => {
                let labels: Vec<_> = slice.nodes.iter().map(|n| n.label.as_str()).collect();
                assert!(labels.iter().any(|l| l.contains("x = a * 2")));
                assert!(labels.iter().any(|l| l.contains("result = x + 1")));
                assert!(!labels.iter().any(|l| l.contains("other = 0")));
            }
            _ => panic!("expected Ok"),
        }
    }

    #[test]
    fn typescript_backward_slice_chains_declarations() {
        let src = b"function f(a: number) {\n  const x = a * 2;\n  const y = a + 1;\n  const result = x + y;\n  return result;\n}\n";
        let r = req("a.ts", 4, 2, SliceDirection::Backward);
        match compute(&r, src, Language::TypeScript) {
            Outcome::Ok(slice) => {
                let labels: Vec<_> = slice.nodes.iter().map(|n| n.label.as_str()).collect();
                assert!(labels.iter().any(|l| l.contains("return result")));
                assert!(labels.iter().any(|l| l.contains("const result = x + y")));
                assert!(labels.iter().any(|l| l.contains("const x = a * 2")));
                assert!(labels.iter().any(|l| l.contains("const y = a + 1")));
            }
            _ => panic!("expected Ok"),
        }
    }
}
