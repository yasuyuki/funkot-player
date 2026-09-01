//! In-memory copy of `hash-index.json`, so the hot paths stop re-parsing it.
//!
//! `store` stays the file layer -- every read and write still goes through it,
//! and its tests still describe the on-disk contract. What this module adds is
//! that the parse happens once per `data_dir` instead of once per interaction.
//!
//! Why the index and not the rest: it is both the biggest file (337 KB at 800
//! tracks) and the one read on every keypress in labeling mode
//! (`set_label_impl`) and on every track change (`record_heard`), purely to
//! turn one path into one hash. Measured on that library, the parse alone was
//! 0.4 ms of the 0.9 ms those paths spent reading, and it grows with the
//! library while the answer needed is a single lookup.
//!
//! Read-only by construction. `store::resolve_content_hash` inserts on a
//! fingerprint miss, and the callers routed here all threw that insert away
//! (their comments say so: the index is persisted by `refresh_library` alone,
//! because a save from anywhere else can overwrite a pruned index with a stale
//! map). Keeping the insert in memory would resurrect that hazard by another
//! door -- a later `refresh_library` would save entries it never scanned -- so
//! a miss here hashes the file and leaves the cache exactly as loaded.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::store::{self, HashIndex};

fn cache() -> &'static Mutex<HashMap<PathBuf, HashIndex>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, HashIndex>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn locked() -> MutexGuard<'static, HashMap<PathBuf, HashIndex>> {
    cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Run `f` against `dir`'s index, loading it from disk on first use.
///
/// The index is not copied out, so this stays O(1) in library size. Keep `f`
/// short: it runs with every other reader of this `dir` blocked.
pub fn with_index<R>(dir: &Path, f: impl FnOnce(&HashIndex) -> R) -> R {
    let mut guard = locked();
    let index = guard
        .entry(dir.to_path_buf())
        .or_insert_with(|| store::load_hash_index(dir).index);
    f(index)
}

/// `path`'s content hash, answered from the cached index when its mtime+size
/// still match.
///
/// Same answer as `store::resolve_content_hash` against a freshly loaded
/// index, minus the insert-on-miss the callers discarded anyway. The hash on a
/// miss is computed after the lock is dropped: it reads the whole file.
pub fn content_hash(dir: &Path, path: &Path) -> io::Result<String> {
    if let Some(hash) = with_index(dir, |index| store::fingerprint_hit(path, index)) {
        return Ok(hash);
    }
    funkot_core::cache::content_hash(path)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))
}

/// `store::save_hash_index`, keeping the cached copy in step.
///
/// Every production save of the index must come through here. A save that
/// bypassed it would leave readers answering from the pre-save map until the
/// process restarts -- which, for a `refresh_library` that just pruned tracks
/// that no longer exist, is exactly the stale state the prune removed.
pub fn save_hash_index(dir: &Path, index: &HashIndex) -> io::Result<()> {
    let result = store::save_hash_index(dir, index);
    if result.is_ok() {
        locked().insert(dir.to_path_buf(), index.clone());
    } else {
        // The file and the cache may now disagree; the next reader reloads.
        locked().remove(dir);
    }
    result
}

/// Drop every cached index.
///
/// For tests: they share this process, and one test's temp dir is another's
/// stale entry only because the OS reuses paths. Production has one data dir
/// for the life of the process.
#[cfg(test)]
pub fn reset() {
    locked().clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::HashIndexEntry;
    use std::fs;

    /// `reset` is process-wide, so these tests cannot run beside each other:
    /// one clearing the cache mid-test is exactly what another is asserting
    /// does not happen.
    fn serialized() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Fresh temp dir per test, cleaned up on drop. Same shape as the one in
    /// `store`'s tests, which is private to that module.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "funkot-player-store-cache-test-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn entry(hash: &str, mtime_ms: u64, len: u64) -> HashIndexEntry {
        HashIndexEntry {
            mtime_ms,
            len,
            hash: hash.into(),
            tags_cached: false,
            title: None,
            artist: None,
            first_seen: None,
            added_order: None,
        }
    }

    /// A second call must not touch the file: proven by deleting it in between
    /// and still getting the loaded answer.
    #[test]
    fn parses_once_per_dir() {
        let _guard = serialized();
        reset();
        let dir = TempDir::new("parses-once");
        let mut index = HashIndex::new();
        index.insert("/music/a.flac".into(), entry("ha", 1, 2));
        store::save_hash_index(&dir.0, &index).unwrap();

        assert_eq!(with_index(&dir.0, |i| i.len()), 1);
        fs::remove_file(dir.0.join("hash-index.json")).unwrap();
        assert_eq!(with_index(&dir.0, |i| i.len()), 1);
        reset();
        assert_eq!(with_index(&dir.0, |i| i.len()), 0);
    }

    /// The fingerprint hit answers from memory for content that no longer
    /// matches what the index says: hashing the file would give another answer.
    #[test]
    fn content_hash_uses_the_cached_fingerprint() {
        let _guard = serialized();
        reset();
        let dir = TempDir::new("fingerprint");
        let track = dir.0.join("a.flac");
        fs::write(&track, b"some bytes").unwrap();
        let meta = fs::metadata(&track).unwrap();
        let mtime_ms = meta
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let mut index = HashIndex::new();
        index.insert(
            track.to_string_lossy().into_owned(),
            entry("cached-hash", mtime_ms, meta.len()),
        );
        store::save_hash_index(&dir.0, &index).unwrap();

        assert_eq!(content_hash(&dir.0, &track).unwrap(), "cached-hash");
    }

    /// A miss must leave the cache as loaded: dropping that insert is what
    /// keeps `refresh_library` the only writer of the index.
    #[test]
    fn a_miss_does_not_grow_the_cache() {
        let _guard = serialized();
        reset();
        let dir = TempDir::new("miss");
        let track = dir.0.join("a.flac");
        fs::write(&track, b"some bytes").unwrap();
        store::save_hash_index(&dir.0, &HashIndex::new()).unwrap();

        assert_eq!(with_index(&dir.0, |i| i.len()), 0);
        let _ = content_hash(&dir.0, &track);
        assert_eq!(with_index(&dir.0, |i| i.len()), 0);
    }

    #[test]
    fn save_replaces_the_cached_copy() {
        let _guard = serialized();
        reset();
        let dir = TempDir::new("save");
        store::save_hash_index(&dir.0, &HashIndex::new()).unwrap();
        assert_eq!(with_index(&dir.0, |i| i.len()), 0);

        let mut index = HashIndex::new();
        index.insert("/music/a.flac".into(), entry("ha", 1, 2));
        save_hash_index(&dir.0, &index).unwrap();

        assert_eq!(with_index(&dir.0, |i| i.len()), 1);
        assert_eq!(store::load_hash_index(&dir.0).index.len(), 1);
    }
}
