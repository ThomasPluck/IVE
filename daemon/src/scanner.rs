//! Workspace scanner: walk files, parse, collect metrics and imports.
//!
//! The scanner is the entry point for `workspace.scan`. Result gets folded into
//! `state::Workspace` which the RPC handlers read from.

use crate::contracts::Location;
use crate::parser::{self, FunctionUnit, Language};
use ignore::WalkBuilder;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct ScannedFile {
    pub relative_path: String,
    pub language: Language,
    pub loc: u32,
    pub functions: Vec<FunctionUnit>,
    pub imports: Vec<ImportEntry>,
    pub blob_sha: String,
    pub bytes_read: usize,
    pub location: Location,
}

#[derive(Debug, Clone)]
pub struct ImportEntry {
    pub module: String,
    pub range_start: [u32; 2],
    pub range_end: [u32; 2],
}

pub fn walk_workspace(root: &Path) -> impl Iterator<Item = std::path::PathBuf> {
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .require_git(false)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            name != ".ive" && name != "node_modules" && name != "target" && name != ".git"
        })
        .build();

    walker.filter_map(Result::ok).filter_map(|e| {
        if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            Some(e.into_path())
        } else {
            None
        }
    })
}

pub fn scan_file(root: &Path, path: &Path) -> anyhow::Result<Option<ScannedFile>> {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let rel_str = relative.to_string_lossy().replace('\\', "/");
    let Some(language) = Language::from_path(&rel_str) else {
        return Ok(None);
    };
    let bytes = std::fs::read(path)?;
    let sha = crate::cache::hash_bytes(&bytes);

    let functions = parser::extract_functions(language, &rel_str, &bytes).unwrap_or_default();
    let imports = match language {
        Language::Python => parser::python::extract_imports(&bytes)
            .into_iter()
            .map(|i| ImportEntry {
                module: i.module,
                range_start: i.range.0,
                range_end: i.range.1,
            })
            .collect(),
        Language::TypeScript | Language::Tsx => {
            parser::typescript::extract_imports(&bytes, matches!(language, Language::Tsx))
                .into_iter()
                .map(|i| ImportEntry {
                    module: i.module,
                    range_start: i.range.0,
                    range_end: i.range.1,
                })
                .collect()
        }
    };
    let loc = bytes.iter().filter(|b| **b == b'\n').count() as u32 + 1;
    let location = Location {
        file: rel_str.clone(),
        range: crate::contracts::Range {
            start: [0, 0],
            end: [loc.saturating_sub(1), 0],
        },
    };
    Ok(Some(ScannedFile {
        relative_path: rel_str,
        language,
        loc,
        functions,
        imports,
        blob_sha: sha,
        bytes_read: bytes.len(),
        location,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn scans_a_small_python_file() {
        let tmp = tempdir();
        let file = tmp.join("a.py");
        std::fs::File::create(&file)
            .unwrap()
            .write_all(b"import os\n\ndef g():\n    if True:\n        return 1\n")
            .unwrap();
        let scanned = scan_file(&tmp, &file).unwrap().unwrap();
        assert_eq!(scanned.relative_path, "a.py");
        assert_eq!(scanned.functions.len(), 1);
        assert_eq!(scanned.functions[0].cognitive_complexity, 1);
        assert_eq!(scanned.imports.len(), 1);
        assert_eq!(scanned.imports[0].module, "os");
        std::fs::remove_dir_all(tmp).ok();
    }

    #[test]
    fn unsupported_extension_returns_none() {
        let tmp = tempdir();
        let file = tmp.join("a.txt");
        std::fs::File::create(&file).unwrap().write_all(b"hi").unwrap();
        let scanned = scan_file(&tmp, &file).unwrap();
        assert!(scanned.is_none());
        std::fs::remove_dir_all(tmp).ok();
    }

    fn tempdir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ive-scan-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
