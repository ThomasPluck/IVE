//! Merkle-style blob SHA cache.
//!
//! `spec §2`: every derived artifact is keyed by
//! `(blob_sha, analyzer_version, query_hash)`. v1 is in-memory only — disk
//! persistence at `.ive/cache/` is a follow-up (see README roadmap).

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

#[derive(Default)]
pub struct BlobIndex {
    inner: RwLock<HashMap<PathBuf, String>>,
}

impl BlobIndex {
    pub fn get(&self, path: &Path) -> Option<String> {
        self.inner.read().ok()?.get(path).cloned()
    }

    pub fn insert(&self, path: PathBuf, sha: String) -> Option<String> {
        let mut guard = self.inner.write().expect("blob index poisoned");
        let prev = guard.insert(path, sha.clone());
        match prev {
            Some(old) if old == sha => Some(old),
            other => other,
        }
    }

    /// Returns `true` if contents hash differs from the cached one (or the
    /// entry is fresh). The new hash is written either way.
    pub fn update_if_changed(&self, path: PathBuf, bytes: &[u8]) -> (bool, String) {
        let sha = hash_bytes(bytes);
        let prev = self.insert(path, sha.clone());
        let changed = prev.as_deref() != Some(sha.as_str());
        (changed, sha)
    }

    pub fn len(&self) -> usize {
        self.inner.read().map(|g| g.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashing_is_deterministic() {
        assert_eq!(hash_bytes(b"hello"), hash_bytes(b"hello"));
        assert_ne!(hash_bytes(b"hello"), hash_bytes(b"world"));
    }

    #[test]
    fn unchanged_file_reports_cache_hit() {
        let idx = BlobIndex::default();
        let p = PathBuf::from("foo.py");
        let (first, sha_a) = idx.update_if_changed(p.clone(), b"print(1)");
        assert!(first, "first write must count as change");
        let (second, sha_b) = idx.update_if_changed(p, b"print(1)");
        assert!(!second, "identical contents must be cache hits");
        assert_eq!(sha_a, sha_b);
    }
}
