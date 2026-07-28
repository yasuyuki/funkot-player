//! Persistence for the playback queue (`queue.json`).
//!
//! Deliberately narrow for now: just the list of paths in order. `library.json`
//! (per-track manual bar overrides, per the plan's B-5 note) is out of scope
//! here.
//!
//! # Where this file lives
//!
//! Callers are expected to pass one of the directories `app_dirs` (in
//! `lib.rs`) already creates — this module does not invent a new directory or
//! ask for any new permission. `queue.json` is derived/internal state, not
//! something the user should see or touch directly, so the natural choice is
//! the same directory `AppDirs::cache_dir` points at (already internal-only:
//! `filesDir/funkot-cache` on Android, `AppData/funkot-cache` on desktop).

use std::collections::VecDeque;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const QUEUE_FILE: &str = "queue.json";

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
    fn save_empty_queue_round_trips_to_empty() {
        let dir = TempDir::new("empty");
        let queue: VecDeque<PathBuf> = VecDeque::new();
        save_queue(&dir.0, &queue).unwrap();
        let loaded = load_queue(&dir.0).unwrap();
        assert!(loaded.is_empty());
    }
}
