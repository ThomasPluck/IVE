//! Parsing and per-function metric extraction.
//!
//! Tree-sitter-only at v1. Symbol resolution for the cross-file workstream (F)
//! lives on top of this — when Stack Graphs land they will slot into
//! `analyzers::ive`, not here. This module must remain language-agnostic in
//! surface area.

pub mod complexity;
pub mod python;
pub mod typescript;

use crate::contracts::{Location, Range, SymbolId};
use tree_sitter::Node;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    Python,
    TypeScript,
    Tsx,
}

impl Language {
    pub fn from_path(path: &str) -> Option<Self> {
        let lower = path.to_ascii_lowercase();
        if lower.ends_with(".py") || lower.ends_with(".pyi") {
            Some(Self::Python)
        } else if lower.ends_with(".tsx") {
            Some(Self::Tsx)
        } else if lower.ends_with(".ts") || lower.ends_with(".mts") || lower.ends_with(".cts") {
            Some(Self::TypeScript)
        } else {
            None
        }
    }

    pub fn ts_language(self) -> tree_sitter::Language {
        match self {
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        }
    }
}

/// A function/method extracted from a file, with cheap structural metrics.
#[derive(Debug, Clone)]
pub struct FunctionUnit {
    pub symbol_id: SymbolId,
    pub name: String,
    pub location: Location,
    pub cognitive_complexity: u32,
    pub loc: u32,
    /// Simple, language-level fan-out — number of distinct identifiers that
    /// appear in call-expression position within this function body. Not an
    /// interprocedural call graph; see `analyzers::ive` for that.
    pub local_callees: Vec<String>,
}

pub fn location_from_node(file: &str, node: &Node) -> Location {
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

pub fn scip_like_id(file: &str, qualified_name: &str) -> SymbolId {
    // Best-effort SCIP moniker until scip-python/scip-typescript land.
    format!("local . ive {} {}#.", file, qualified_name)
}

/// Extract function units from a file.
pub fn extract_functions(
    lang: Language,
    file: &str,
    source: &[u8],
) -> anyhow::Result<Vec<FunctionUnit>> {
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&lang.ts_language())
        .map_err(|e| anyhow::anyhow!("set_language: {e}"))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| anyhow::anyhow!("tree-sitter parser returned None"))?;

    let mut out = Vec::new();
    match lang {
        Language::Python => python::walk(tree.root_node(), source, file, &mut out),
        Language::TypeScript | Language::Tsx => {
            typescript::walk(tree.root_node(), source, file, &mut out)
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_detection() {
        assert_eq!(Language::from_path("foo.py"), Some(Language::Python));
        assert_eq!(Language::from_path("foo.ts"), Some(Language::TypeScript));
        assert_eq!(Language::from_path("Foo.TSX"), Some(Language::Tsx));
        assert_eq!(Language::from_path("foo.go"), None);
    }
}
