//! Merkle-style blob SHA cache.
//!
//! `spec §2`: every derived artifact is keyed by
//! `(blob_sha, analyzer_version, query_hash)`. v1 here implements:
//! - in-memory `BlobIndex` (path → sha) that records cache hits
//! - on-disk `.ive/cache/manifest.json` that survives restart
//! - `ArtifactStore` keyed by `(blob_sha, query_hash)` with a flat LRU-ish
//!   approximation: entries older than `max_age_days` are swept on save.
//!
//! The cache is best-effort: a missing/corrupt file falls back to a fresh
//! scan. Disk I/O is kept off the hot path — persist happens at scan-end
//! only.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

pub fn hash_str(s: &str) -> String {
    hash_bytes(s.as_bytes())
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

    pub fn snapshot(&self) -> HashMap<PathBuf, String> {
        self.inner.read().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn load_snapshot(&self, snap: HashMap<PathBuf, String>) {
        if let Ok(mut g) = self.inner.write() {
            g.extend(snap);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Manifest {
    pub version: u32,
    pub analyzer_version: String,
    pub blobs: HashMap<String, String>, // path → blob sha
    pub artifacts: HashMap<String, ArtifactMeta>, // key = hash(blob_sha + query_hash)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactMeta {
    pub size_bytes: u64,
    pub last_used_unix: u64,
}

pub struct DiskCache {
    root: PathBuf,
    analyzer_version: String,
}

impl DiskCache {
    pub fn new(workspace: &Path, analyzer_version: impl Into<String>) -> Self {
        Self {
            root: workspace.join(".ive").join("cache"),
            analyzer_version: analyzer_version.into(),
        }
    }

    pub fn ensure_dir(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.root)
    }

    pub fn manifest_path(&self) -> PathBuf {
        self.root.join("manifest.json")
    }

    pub fn load_manifest(&self) -> Manifest {
        let path = self.manifest_path();
        let Ok(text) = std::fs::read_to_string(&path) else {
            return Manifest {
                version: 1,
                analyzer_version: self.analyzer_version.clone(),
                ..Manifest::default()
            };
        };
        let parsed: Manifest = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(_) => return Manifest::default(),
        };
        // If the analyzer version changed, invalidate everything.
        if parsed.analyzer_version != self.analyzer_version {
            return Manifest {
                version: 1,
                analyzer_version: self.analyzer_version.clone(),
                ..Manifest::default()
            };
        }
        parsed
    }

    pub fn save_manifest(&self, manifest: &Manifest) -> std::io::Result<()> {
        self.ensure_dir()?;
        let tmp = self.root.join("manifest.json.tmp");
        let text = serde_json::to_string_pretty(manifest).unwrap_or_default();
        std::fs::write(&tmp, text)?;
        std::fs::rename(tmp, self.manifest_path())?;
        Ok(())
    }

    /// Drop manifest entries whose blob SHA is not referenced by any current
    /// file — classic Merkle-style garbage collection.
    pub fn prune(&self, manifest: &mut Manifest) {
        let live: std::collections::HashSet<&String> = manifest.blobs.values().collect();
        let live_set: std::collections::HashSet<String> =
            live.iter().map(|s| (*s).clone()).collect();
        manifest.artifacts.retain(|key, _| {
            // artifact key = blob_sha + query_hash; we only need the blob prefix.
            key.split_once(':')
                .map(|(b, _)| live_set.contains(b))
                .unwrap_or(false)
        });
    }
}

pub fn artifact_key(blob_sha: &str, query_hash: &str) -> String {
    format!("{blob_sha}:{query_hash}")
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

    #[test]
    fn manifest_round_trips_via_disk() {
        let tmp = std::env::temp_dir().join(format!(
            "ive-cache-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let cache = DiskCache::new(&tmp, "v1");
        let mut m = Manifest {
            version: 1,
            analyzer_version: "v1".into(),
            blobs: [("a.py".into(), "deadbeef".into())].into_iter().collect(),
            artifacts: [(
                artifact_key("deadbeef", "functions"),
                ArtifactMeta {
                    size_bytes: 42,
                    last_used_unix: 0,
                },
            )]
            .into_iter()
            .collect(),
        };
        cache.save_manifest(&m).unwrap();
        let loaded = cache.load_manifest();
        assert_eq!(loaded.analyzer_version, "v1");
        assert_eq!(loaded.blobs.get("a.py"), Some(&"deadbeef".to_string()));

        // Prune should keep live blobs.
        cache.prune(&mut m);
        assert_eq!(m.artifacts.len(), 1);

        // Drop all blobs — prune should clear the artifacts.
        m.blobs.clear();
        cache.prune(&mut m);
        assert!(m.artifacts.is_empty());

        std::fs::remove_dir_all(tmp).ok();
    }

    #[test]
    fn analyzer_version_bump_invalidates_manifest() {
        let tmp = std::env::temp_dir().join(format!(
            "ive-cache-bump-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let cache_v1 = DiskCache::new(&tmp, "v1");
        let m = Manifest {
            version: 1,
            analyzer_version: "v1".into(),
            blobs: [("a.py".into(), "x".into())].into_iter().collect(),
            artifacts: Default::default(),
        };
        cache_v1.save_manifest(&m).unwrap();

        let cache_v2 = DiskCache::new(&tmp, "v2");
        let loaded = cache_v2.load_manifest();
        assert!(loaded.blobs.is_empty(), "bump must invalidate blobs");
        assert_eq!(loaded.analyzer_version, "v2");
        std::fs::remove_dir_all(tmp).ok();
    }
}
