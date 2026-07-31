//! Persistence for the playback queue (`queue.json`) and for the bar counts
//! the user has corrected by hand (`library.json`).
//!
//! # Why the app keeps its own copy of the manual bars
//!
//! The engine already stores them in its analysis cache, but that cache is
//! keyed by `CACHE_VERSION` and thrown away wholesale when the analyzer
//! changes: `cache::load` returns `None` on a version mismatch, and the next
//! scan re-analyzes the file and overwrites the entry. A correction the user
//! typed in would disappear silently at the next engine update — which is
//! exactly when the analyzer's own numbers move and the correction matters
//! most. Keeping our own copy lets the app re-apply it after every fresh
//! analysis, and it is the honest ownership anyway: what the listener decided
//! is the app's data, not a byproduct of an analysis run.
//!
//! Entries are keyed by `funkot_core::cache::content_hash`, the same key the
//! engine's cache uses, so moving or renaming a file keeps its corrections.
//!
//! # Where this file lives
//!
//! Callers are expected to pass one of the directories `app_dirs` (in
//! `lib.rs`) already creates — this module does not invent a new directory or
//! ask for any new permission. `queue.json` is derived/internal state, not
//! something the user should see or touch directly, so the natural choice is
//! the same directory `AppDirs::cache_dir` points at (already internal-only:
//! `filesDir/funkot-cache` on Android, `AppData/funkot-cache` on desktop).

use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const QUEUE_FILE: &str = "queue.json";
const LIBRARY_FILE: &str = "library.json";

/// Load the queue previously saved under `dir`.
///
/// Returns an empty `Vec` (not an error) if the file does not exist yet, so
/// first-run callers do not need to special-case "no queue saved".
pub fn load_queue(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let path = dir.join(QUEUE_FILE);
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let paths: Vec<PathBuf> = serde_json::from_slice(&bytes)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(paths)
}

/// Persist `queue`'s current contents under `dir`, overwriting any previous
/// save.
pub fn save_queue(dir: &Path, queue: &VecDeque<PathBuf>) -> io::Result<()> {
    let paths: Vec<&PathBuf> = queue.iter().collect();
    let json = serde_json::to_vec_pretty(&paths)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(dir.join(QUEUE_FILE), json)
}

/// Bar counts the user corrected by hand for one track.
///
/// A side left as `None` was never touched, and stays whatever the analyzer
/// says — including after a reanalysis moves it. Only what the user actually
/// changed is pinned.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BarOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intro_bars: Option<u32>,
    /// The *structural* outro boundary, not the mix trigger. The trigger is
    /// derived from it by the engine (boundary + a fixed lead-in), so pinning
    /// the trigger instead would fight that rule; see
    /// `funkot_core::cache::set_manual_structure_bars`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outro_structure_bars: Option<u32>,
}

/// Hand-corrected bars for the whole library, keyed by content hash.
pub type Overrides = BTreeMap<String, BarOverride>;

/// Load the hand-corrected bars saved under `dir`.
///
/// A missing file is an empty map, not an error (first run). A *corrupt* file
/// is also an empty map: the alternative is refusing to scan the library at
/// all, and these are corrections the user can redo — losing them is
/// recoverable, a library that will not open is not.
pub fn load_overrides(dir: &Path) -> Overrides {
    let bytes = match fs::read(dir.join(LIBRARY_FILE)) {
        Ok(b) => b,
        Err(_) => return Overrides::new(),
    };
    match serde_json::from_slice(&bytes) {
        Ok(map) => map,
        Err(e) => {
            log::warn!("{LIBRARY_FILE} is unreadable, starting empty: {e}");
            Overrides::new()
        }
    }
}

/// Persist `overrides` under `dir`, overwriting any previous save.
pub fn save_overrides(dir: &Path, overrides: &Overrides) -> io::Result<()> {
    let json = serde_json::to_vec_pretty(overrides)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(dir.join(LIBRARY_FILE), json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// Fresh temp dir per test, cleaned up on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "funkot-player-store-test-{name}-{}-{}",
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

    #[test]
    fn load_queue_missing_file_is_empty_not_an_error() {
        let dir = TempDir::new("missing");
        let loaded = load_queue(&dir.0).unwrap();
        assert!(loaded.is_empty());
    }

    #[test]
    fn save_then_load_round_trips_order() {
        let dir = TempDir::new("roundtrip");
        let mut queue: VecDeque<PathBuf> = VecDeque::new();
        queue.push_back(PathBuf::from("/music/a.flac"));
        queue.push_back(PathBuf::from("/music/b.mp3"));
        queue.push_back(PathBuf::from("/music/c.wav"));

        save_queue(&dir.0, &queue).unwrap();
        let loaded = load_queue(&dir.0).unwrap();

        assert_eq!(
            loaded,
            vec![
                PathBuf::from("/music/a.flac"),
                PathBuf::from("/music/b.mp3"),
                PathBuf::from("/music/c.wav"),
            ]
        );
    }

    #[test]
    fn save_overwrites_previous_contents() {
        let dir = TempDir::new("overwrite");
        let mut queue: VecDeque<PathBuf> = VecDeque::new();
        queue.push_back(PathBuf::from("/music/a.flac"));
        save_queue(&dir.0, &queue).unwrap();

        let mut queue2: VecDeque<PathBuf> = VecDeque::new();
        queue2.push_back(PathBuf::from("/music/b.flac"));
        save_queue(&dir.0, &queue2).unwrap();

        let loaded = load_queue(&dir.0).unwrap();
        assert_eq!(loaded, vec![PathBuf::from("/music/b.flac")]);
    }

    #[test]
    fn overrides_round_trip_one_side_at_a_time() {
        let dir = TempDir::new("overrides");
        let mut o = Overrides::new();
        o.insert(
            "aaa".into(),
            BarOverride {
                intro_bars: Some(32),
                outro_structure_bars: None,
            },
        );
        o.insert(
            "bbb".into(),
            BarOverride {
                intro_bars: None,
                outro_structure_bars: Some(16),
            },
        );

        save_overrides(&dir.0, &o).unwrap();
        let loaded = load_overrides(&dir.0);

        assert_eq!(loaded, o);
        assert_eq!(loaded["aaa"].outro_structure_bars, None);
        assert_eq!(loaded["bbb"].intro_bars, None);
    }

    #[test]
    fn missing_overrides_file_is_empty() {
        let dir = TempDir::new("overrides-missing");
        assert!(load_overrides(&dir.0).is_empty());
    }

    /// A corrupt file must not take the library down with it.
    #[test]
    fn corrupt_overrides_file_is_empty_not_a_panic() {
        let dir = TempDir::new("overrides-corrupt");
        fs::write(dir.0.join(LIBRARY_FILE), b"{not json").unwrap();
        assert!(load_overrides(&dir.0).is_empty());
    }

    #[test]
    fn save_empty_queue_round_trips_to_empty() {
        let dir = TempDir::new("empty");
        let queue: VecDeque<PathBuf> = VecDeque::new();
        save_queue(&dir.0, &queue).unwrap();
        let loaded = load_queue(&dir.0).unwrap();
        assert!(loaded.is_empty());
    }
}
