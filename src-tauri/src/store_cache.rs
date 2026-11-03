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

pub fn with_index<R>(dir: &Path, f: impl FnOnce(&HashIndex) -> R) -> R {
    let mut guard = locked();
    let index = guard
        .entry(dir.to_path_buf())
        .or_insert_with(|| store::load_hash_index(dir).index);
    f(index)
}

pub fn content_hash(dir: &Path, path: &Path) -> io::Result<String> {
    if let Some(hash) = with_index(dir, |index| store::fingerprint_hit(path, index)) {
        return Ok(hash);
    }
    funkot_core::cache::content_hash(path)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))
}

pub fn save_hash_index(dir: &Path, index: &HashIndex) -> io::Result<()> {
    let result = store::save_hash_index(dir, index);
    if result.is_ok() {
        locked().insert(dir.to_path_buf(), index.clone());
    } else {
        locked().remove(dir);
    }
    result
}

#[cfg(test)]
pub fn reset() {
    locked().clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::HashIndexEntry;
    use std::fs;

    fn serialized() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

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
                metadata_version: 0,
                embedded_metadata: None,
                metadata_error: None,
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
