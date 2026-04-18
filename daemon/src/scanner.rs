//! Workspace scanner: walk files, parse, collect metrics and imports.
//!
//! The scanner is the entry point for `workspace.scan`. Result gets folded
//! into `state::Workspace` which the RPC handlers read from.
//!
//! Parse-result caching: `scan_file_with_cache` uses a SHA-keyed cache so
//! re-scanning an unchanged file skips tree-sitter entirely. That's as
//! close as we can get to incremental reparse without editor-level edit
//! tracking — tree-sitter's `Tree::edit` needs `InputEdit` ranges from
//! the client, which the LSP path will supply in a later milestone.
//! For now: if the content hash matches, reuse the previous
//! `ScannedFile`; otherwise full reparse. Either path keeps the blob
//! index updated for the next scan.

use crate::contracts::Location;
use crate::parser::{self, FunctionUnit, Language};
use ignore::WalkBuilder;
use std::collections::HashMap;
use std::path::Path;
use std::sync::RwLock;

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

/// SHA-keyed parse-result cache. Safe to share across threads via `Arc`.
#[derive(Default)]
pub struct ParseCache {
    inner: RwLock<HashMap<String, ScannedFile>>,
    hits: std::sync::atomic::AtomicU64,
    misses: std::sync::atomic::AtomicU64,
}

impl ParseCache {
    pub fn get(&self, sha: &str) -> Option<ScannedFile> {
        let res = self.inner.read().ok()?.get(sha).cloned();
        match &res {
            Some(_) => self.hits.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            None => self
                .misses
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        };
        res
    }

    pub fn insert(&self, sha: String, scanned: ScannedFile) {
        if let Ok(mut g) = self.inner.write() {
            g.insert(sha, scanned);
        }
    }

    pub fn stats(&self) -> (u64, u64) {
        (
            self.hits.load(std::sync::atomic::Ordering::Relaxed),
            self.misses.load(std::sync::atomic::Ordering::Relaxed),
        )
    }

    pub fn len(&self) -> usize {
        self.inner.read().map(|g| g.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Drop entries whose SHA isn't in `live` — call after a scan to keep
    /// memory bounded to the current workspace.
    pub fn retain_shas(&self, live: &std::collections::HashSet<String>) {
        if let Ok(mut g) = self.inner.write() {
            g.retain(|k, _| live.contains(k));
        }
    }
}

pub fn scan_file(root: &Path, path: &Path) -> anyhow::Result<Option<ScannedFile>> {
    // Backwards-compatible entry point for callers that don't carry a cache
    // (tests, one-shot CLI scan).
    scan_file_with_cache(root, path, None)
}

pub fn scan_file_with_cache(
    root: &Path,
    path: &Path,
    cache: Option<&ParseCache>,
) -> anyhow::Result<Option<ScannedFile>> {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let rel_str = relative.to_string_lossy().replace('\\', "/");
    let Some(language) = Language::from_path(&rel_str) else {
        return Ok(None);
    };
    let bytes = std::fs::read(path)?;
    let sha = crate::cache::hash_bytes(&bytes);

    if let Some(cache) = cache {
        if let Some(mut cached) = cache.get(&sha) {
            // The cache is keyed by content hash — if the file was moved
            // but has the same contents, update the relative path so
            // downstream consumers see the real location.
            if cached.relative_path != rel_str {
                cached.relative_path = rel_str.clone();
                cached.location.file = rel_str.clone();
            }
            return Ok(Some(cached));
        }
    }

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
        Language::Rust => parser::rust::extract_uses(&bytes)
            .into_iter()
            .map(|u| ImportEntry {
                module: u.crate_name,
                range_start: u.range.0,
                range_end: u.range.1,
            })
            .collect(),
    };
    let loc = bytes.iter().filter(|b| **b == b'\n').count() as u32 + 1;
    let location = Location {
        file: rel_str.clone(),
        range: crate::contracts::Range {
            start: [0, 0],
            end: [loc.saturating_sub(1), 0],
        },
    };
    let scanned = ScannedFile {
        relative_path: rel_str,
        language,
        loc,
        functions,
        imports,
        blob_sha: sha.clone(),
        bytes_read: bytes.len(),
        location,
    };
    if let Some(cache) = cache {
        cache.insert(sha, scanned.clone());
    }
    Ok(Some(scanned))
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
        std::fs::File::create(&file)
            .unwrap()
            .write_all(b"hi")
            .unwrap();
        let scanned = scan_file(&tmp, &file).unwrap();
        assert!(scanned.is_none());
        std::fs::remove_dir_all(tmp).ok();
    }

    #[test]
    fn parse_cache_skips_tree_sitter_on_unchanged_sha() {
        let tmp = tempdir();
        let file = tmp.join("a.py");
        std::fs::File::create(&file)
            .unwrap()
            .write_all(b"def f():\n    return 42\n")
            .unwrap();
        let cache = ParseCache::default();

        let first = scan_file_with_cache(&tmp, &file, Some(&cache))
            .unwrap()
            .unwrap();
        assert_eq!(cache.stats(), (0, 1), "first scan is a cache miss");
        assert_eq!(cache.len(), 1);

        let second = scan_file_with_cache(&tmp, &file, Some(&cache))
            .unwrap()
            .unwrap();
        assert_eq!(cache.stats(), (1, 1), "second scan must be a cache hit");
        assert_eq!(first.blob_sha, second.blob_sha);
        assert_eq!(first.functions[0].name, second.functions[0].name);

        std::fs::remove_dir_all(tmp).ok();
    }

    #[test]
    fn parse_cache_invalidates_on_content_change() {
        let tmp = tempdir();
        let file = tmp.join("a.py");
        std::fs::write(&file, b"def f():\n    return 1\n").unwrap();
        let cache = ParseCache::default();

        let a = scan_file_with_cache(&tmp, &file, Some(&cache))
            .unwrap()
            .unwrap();
        std::fs::write(&file, b"def f():\n    if True:\n        return 2\n").unwrap();
        let b = scan_file_with_cache(&tmp, &file, Some(&cache))
            .unwrap()
            .unwrap();
        assert_ne!(a.blob_sha, b.blob_sha, "sha must change on edit");
        assert_ne!(
            a.functions[0].cognitive_complexity, b.functions[0].cognitive_complexity,
            "cognitive complexity should reflect the new branch"
        );
        assert_eq!(
            cache.stats(),
            (0, 2),
            "both scans miss since content differs"
        );
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
