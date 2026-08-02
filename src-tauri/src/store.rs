//! Persistence for the playback queue (`queue.json`), the bar counts the
//! user has corrected by hand (`library.json`), and transition flags the
//! listener marked as bad (`flags.json`).
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
//! # Where these files live
//!
//! In `AppDirs::data_dir`, and deliberately *not* in the analysis cache.
//! These files are the listener's own work — the queue they built, the
//! corrections they made, and the transitions they flagged — whereas the
//! cache holds derived data that is meant to be disposable, and that the
//! README tells people to delete outright when analysis misbehaves. User
//! data under a directory whose published repair step is `rm -rf` does not
//! survive the first repair. `data_dir` is still internal storage
//! (`filesDir` on Android, the app data dir on desktop), so this asks for
//! no new permission and stays out of the MTP-visible folder.
//!
//! Early builds did keep queue/library in the cache; `migrate_from` moves
//! anything still there (including `flags.json` if present).

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const QUEUE_FILE: &str = "queue.json";
const LIBRARY_FILE: &str = "library.json";
const FLAGS_FILE: &str = "flags.json";
const DISMISSED_FILE: &str = "dismissed.json";

/// Move persisted files from a previous location into `dir`, if they are
/// still there. Safe to call on every launch; a no-op once nothing is left
/// behind.
///
/// A file already present at the destination wins and the stale copy is left
/// alone: the destination is the live one, and overwriting it with an older
/// copy would undo everything that happened since the move.
///
/// Failures are logged, not returned. Losing the move costs the user their
/// queue and corrections *later*; failing the launch costs them the app now.
pub fn migrate_from(old_dir: &Path, dir: &Path) {
    if old_dir == dir {
        return;
    }
    for name in [QUEUE_FILE, LIBRARY_FILE, FLAGS_FILE, DISMISSED_FILE] {
        let from = old_dir.join(name);
        let to = dir.join(name);
        if !from.exists() || to.exists() {
            continue;
        }
        // Both directories are inside the app's own storage, so this is always
        // a same-filesystem rename — there is no cross-device case to handle.
        match fs::rename(&from, &to) {
            Ok(()) => log::info!("moved {name} out of {}", old_dir.display()),
            Err(e) => log::warn!("cannot move {name} out of {}: {e}", old_dir.display()),
        }
    }
}

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

/// One automatic transition pair the listener flagged as bad.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TransitionFlag {
    pub count: u32,
    /// Unix epoch milliseconds of the most recent flag press for this pair.
    pub last_flagged_ms: u64,
}

/// Keyed by `"from_hash\tto_hash"` (content hashes joined by a single TAB).
pub type Flags = BTreeMap<String, TransitionFlag>;

/// Build the map key for a flagged transition pair.
pub fn flag_key(from_hash: &str, to_hash: &str) -> String {
    format!("{from_hash}\t{to_hash}")
}

/// Load transition flags saved under `dir`.
///
/// Missing or corrupt → empty map (same policy as [`load_overrides`]).
pub fn load_flags(dir: &Path) -> Flags {
    let bytes = match fs::read(dir.join(FLAGS_FILE)) {
        Ok(b) => b,
        Err(_) => return Flags::new(),
    };
    match serde_json::from_slice(&bytes) {
        Ok(map) => map,
        Err(e) => {
            log::warn!("{FLAGS_FILE} is unreadable, starting empty: {e}");
            Flags::new()
        }
    }
}

/// Persist `flags` under `dir`, overwriting any previous save.
pub fn save_flags(dir: &Path, flags: &Flags) -> io::Result<()> {
    let json = serde_json::to_vec_pretty(flags)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(dir.join(FLAGS_FILE), json)
}

/// Keys of track×role rows the listener dismissed from the edit list.
///
/// Does not remove the underlying flag pairs — only hides those rows from
/// [`aggregate_flags`]. Keyed by [`dismiss_key`].
pub type Dismissed = BTreeSet<String>;

/// Build the map key for a dismissed track×role row.
pub fn dismiss_key(track_hash: &str, role: &str) -> String {
    format!("{track_hash}\t{role}")
}

/// Load dismissed track×role keys saved under `dir`.
///
/// Missing or corrupt → empty set (same policy as [`load_flags`]).
pub fn load_dismissed(dir: &Path) -> Dismissed {
    let bytes = match fs::read(dir.join(DISMISSED_FILE)) {
        Ok(b) => b,
        Err(_) => return Dismissed::new(),
    };
    match serde_json::from_slice(&bytes) {
        Ok(set) => set,
        Err(e) => {
            log::warn!("{DISMISSED_FILE} is unreadable, starting empty: {e}");
            Dismissed::new()
        }
    }
}

/// Persist `dismissed` under `dir`, overwriting any previous save.
pub fn save_dismissed(dir: &Path, dismissed: &Dismissed) -> io::Result<()> {
    let json = serde_json::to_vec_pretty(dismissed)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(dir.join(DISMISSED_FILE), json)
}

/// Display / confidence / bar metadata for one content hash, used by
/// [`aggregate_flags`]. Built by the command from the music folder scan
/// (same sources as `track_row` / `analyzed_cache_entry`).
#[derive(Debug, Clone)]
pub struct FlagTrackMeta {
    pub title: String,
    pub artist: String,
    pub intro_low_confidence: bool,
    pub outro_low_confidence: bool,
    pub path: Option<String>,
    pub intro_bars: Option<u32>,
    pub outro_structure_bars: Option<u32>,
    /// Mix-trigger bars derived by the engine (read-only in the UI).
    pub outro_bars: Option<u32>,
    pub intro_manual: bool,
    pub outro_manual: bool,
    pub analyzed: bool,
}

/// One partner of a [`FlaggedTrackRow`] (the other side of a flagged pair).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FlagPartner {
    pub track_hash: String,
    pub title: String,
    pub count: u32,
    pub missing: bool,
}

/// One aggregated row: a track in one role (outgoing or incoming).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FlaggedTrackRow {
    pub track_hash: String,
    /// `"outgoing"` (出る側) or `"incoming"` (入る側).
    pub role: String,
    pub title: String,
    pub artist: String,
    pub count: u32,
    pub low_confidence: bool,
    pub missing: bool,
    pub partners: Vec<FlagPartner>,
    pub path: Option<String>,
    pub intro_bars: Option<u32>,
    pub outro_structure_bars: Option<u32>,
    /// Mix-trigger bars derived by the engine (read-only in the UI).
    pub outro_bars: Option<u32>,
    pub intro_manual: bool,
    pub outro_manual: bool,
    pub analyzed: bool,
}

const MISSING_TITLE: &str = "ライブラリにない曲";
const ROLE_OUTGOING: &str = "outgoing";
const ROLE_INCOMING: &str = "incoming";

/// Aggregate raw `from\tto` flags into track×role rows for the edit tab.
///
/// Pure: no I/O. `meta_by_hash` is whatever the caller resolved from the
/// library scan; hashes absent from it become `missing` rows.
/// Rows whose `(track_hash, role)` is in `dismissed` are omitted; partner
/// tallies still come from the full `flags` map.
pub fn aggregate_flags(
    flags: &Flags,
    meta_by_hash: &BTreeMap<String, FlagTrackMeta>,
    dismissed: &Dismissed,
) -> Vec<FlaggedTrackRow> {
    use std::collections::HashMap;

    // (track_hash, role) → (total count, partner_hash → count)
    let mut acc: HashMap<(String, &'static str), (u32, HashMap<String, u32>)> = HashMap::new();

    for (key, flag) in flags {
        let Some((from, to)) = key.split_once('\t') else {
            continue;
        };
        if from.is_empty() || to.is_empty() {
            continue;
        }
        let count = flag.count;
        if count == 0 {
            continue;
        }

        for (track, role, partner) in [
            (from, ROLE_OUTGOING, to),
            (to, ROLE_INCOMING, from),
        ] {
            let entry = acc
                .entry((track.to_string(), role))
                .or_insert_with(|| (0, HashMap::new()));
            entry.0 = entry.0.saturating_add(count);
            let partner_count = entry.1.entry(partner.to_string()).or_insert(0);
            *partner_count = partner_count.saturating_add(count);
        }
    }

    let resolve = |hash: &str| -> (
        String,
        String,
        bool,
        bool,
        bool,
        Option<String>,
        Option<u32>,
        Option<u32>,
        Option<u32>,
        bool,
        bool,
        bool,
    ) {
        match meta_by_hash.get(hash) {
            Some(m) => (
                m.title.clone(),
                m.artist.clone(),
                m.intro_low_confidence,
                m.outro_low_confidence,
                false,
                m.path.clone(),
                m.intro_bars,
                m.outro_structure_bars,
                m.outro_bars,
                m.intro_manual,
                m.outro_manual,
                m.analyzed,
            ),
            None => (
                MISSING_TITLE.to_string(),
                String::new(),
                false,
                false,
                true,
                None,
                None,
                None,
                None,
                false,
                false,
                false,
            ),
        }
    };

    let mut rows: Vec<FlaggedTrackRow> = acc
        .into_iter()
        .filter(|((track_hash, role), _)| {
            !dismissed.contains(&dismiss_key(track_hash, role))
        })
        .map(|((track_hash, role), (count, partners_map))| {
            let (
                title,
                artist,
                intro_low,
                outro_low,
                missing,
                path,
                intro_bars,
                outro_structure_bars,
                outro_bars,
                intro_manual,
                outro_manual,
                analyzed,
            ) = resolve(&track_hash);
            let low_confidence = if missing {
                false
            } else if role == ROLE_OUTGOING {
                outro_low
            } else {
                intro_low
            };

            let mut partners: Vec<FlagPartner> = partners_map
                .into_iter()
                .map(|(partner_hash, pcount)| {
                    let (ptitle, _, _, _, pmissing, _, _, _, _, _, _, _) =
                        resolve(&partner_hash);
                    FlagPartner {
                        track_hash: partner_hash,
                        title: ptitle,
                        count: pcount,
                        missing: pmissing,
                    }
                })
                .collect();
            partners.sort_by(|a, b| {
                b.count
                    .cmp(&a.count)
                    .then_with(|| a.title.cmp(&b.title))
                    .then_with(|| a.track_hash.cmp(&b.track_hash))
            });

            FlaggedTrackRow {
                track_hash,
                role: role.to_string(),
                title,
                artist,
                count,
                low_confidence,
                missing,
                partners,
                path,
                intro_bars,
                outro_structure_bars,
                outro_bars,
                intro_manual,
                outro_manual,
                analyzed,
            }
        })
        .collect();

    rows.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| {
                // outgoing before incoming
                let ra = if a.role == ROLE_OUTGOING { 0 } else { 1 };
                let rb = if b.role == ROLE_OUTGOING { 0 } else { 1 };
                ra.cmp(&rb)
            })
            .then_with(|| a.title.cmp(&b.title))
            .then_with(|| a.track_hash.cmp(&b.track_hash))
    });

    rows
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
    fn migrate_moves_all_files_and_leaves_nothing_behind() {
        let old = TempDir::new("migrate-old");
        let new = TempDir::new("migrate-new");

        let mut queue: VecDeque<PathBuf> = VecDeque::new();
        queue.push_back(PathBuf::from("/music/a.flac"));
        save_queue(&old.0, &queue).unwrap();
        let mut o = Overrides::new();
        o.insert("aaa".into(), BarOverride { intro_bars: Some(32), outro_structure_bars: None });
        save_overrides(&old.0, &o).unwrap();
        let mut flags = Flags::new();
        flags.insert(
            flag_key("from", "to"),
            TransitionFlag {
                count: 1,
                last_flagged_ms: 1,
            },
        );
        save_flags(&old.0, &flags).unwrap();

        migrate_from(&old.0, &new.0);

        assert_eq!(load_queue(&new.0).unwrap(), vec![PathBuf::from("/music/a.flac")]);
        assert_eq!(load_overrides(&new.0), o);
        assert_eq!(load_flags(&new.0), flags);
        assert!(!old.0.join(QUEUE_FILE).exists());
        assert!(!old.0.join(LIBRARY_FILE).exists());
        assert!(!old.0.join(FLAGS_FILE).exists());
    }

    /// The whole point is that this runs on every launch.
    #[test]
    fn migrate_with_nothing_to_move_is_a_no_op() {
        let old = TempDir::new("migrate-empty-old");
        let new = TempDir::new("migrate-empty-new");
        migrate_from(&old.0, &new.0);
        assert!(load_queue(&new.0).unwrap().is_empty());
        assert!(load_overrides(&new.0).is_empty());
        assert!(load_flags(&new.0).is_empty());
    }

    /// A leftover in the old location must never clobber the live file.
    #[test]
    fn migrate_keeps_the_destination_when_both_exist() {
        let old = TempDir::new("migrate-both-old");
        let new = TempDir::new("migrate-both-new");

        let mut stale: VecDeque<PathBuf> = VecDeque::new();
        stale.push_back(PathBuf::from("/music/stale.flac"));
        save_queue(&old.0, &stale).unwrap();
        let mut live: VecDeque<PathBuf> = VecDeque::new();
        live.push_back(PathBuf::from("/music/live.flac"));
        save_queue(&new.0, &live).unwrap();

        migrate_from(&old.0, &new.0);

        assert_eq!(load_queue(&new.0).unwrap(), vec![PathBuf::from("/music/live.flac")]);
    }

    /// `data_dir == cache_dir` would otherwise rename a file onto itself.
    #[test]
    fn migrate_from_the_same_directory_leaves_the_file_alone() {
        let dir = TempDir::new("migrate-same");
        let mut queue: VecDeque<PathBuf> = VecDeque::new();
        queue.push_back(PathBuf::from("/music/a.flac"));
        save_queue(&dir.0, &queue).unwrap();

        migrate_from(&dir.0, &dir.0);

        assert_eq!(load_queue(&dir.0).unwrap(), vec![PathBuf::from("/music/a.flac")]);
    }

    #[test]
    fn save_empty_queue_round_trips_to_empty() {
        let dir = TempDir::new("empty");
        let queue: VecDeque<PathBuf> = VecDeque::new();
        save_queue(&dir.0, &queue).unwrap();
        let loaded = load_queue(&dir.0).unwrap();
        assert!(loaded.is_empty());
    }

    #[test]
    fn flags_round_trip() {
        let dir = TempDir::new("flags-roundtrip");
        let mut flags = Flags::new();
        flags.insert(
            flag_key("aaa", "bbb"),
            TransitionFlag {
                count: 3,
                last_flagged_ms: 1_700_000_000_000,
            },
        );
        save_flags(&dir.0, &flags).unwrap();
        assert_eq!(load_flags(&dir.0), flags);
    }

    #[test]
    fn missing_flags_file_is_empty() {
        let dir = TempDir::new("flags-missing");
        assert!(load_flags(&dir.0).is_empty());
    }

    #[test]
    fn corrupt_flags_file_is_empty_not_a_panic() {
        let dir = TempDir::new("flags-corrupt");
        fs::write(dir.0.join(FLAGS_FILE), b"{not json").unwrap();
        assert!(load_flags(&dir.0).is_empty());
    }

    #[test]
    fn flagging_same_key_twice_increments_count() {
        let dir = TempDir::new("flags-merge");
        let key = flag_key("from_hash", "to_hash");

        let mut flags = Flags::new();
        flags.insert(
            key.clone(),
            TransitionFlag {
                count: 1,
                last_flagged_ms: 100,
            },
        );
        save_flags(&dir.0, &flags).unwrap();

        let mut flags = load_flags(&dir.0);
        let entry = flags.entry(key.clone()).or_insert(TransitionFlag {
            count: 0,
            last_flagged_ms: 0,
        });
        entry.count += 1;
        entry.last_flagged_ms = 200;
        save_flags(&dir.0, &flags).unwrap();

        let loaded = load_flags(&dir.0);
        assert_eq!(loaded[&key].count, 2);
        assert_eq!(loaded[&key].last_flagged_ms, 200);
    }

    fn meta(
        title: &str,
        artist: &str,
        intro_low: bool,
        outro_low: bool,
    ) -> FlagTrackMeta {
        FlagTrackMeta {
            title: title.into(),
            artist: artist.into(),
            intro_low_confidence: intro_low,
            outro_low_confidence: outro_low,
            path: Some(format!("/music/{title}.flac")),
            intro_bars: Some(16),
            outro_structure_bars: Some(32),
            outro_bars: Some(48),
            intro_manual: false,
            outro_manual: false,
            analyzed: true,
        }
    }

    fn flag(count: u32) -> TransitionFlag {
        TransitionFlag {
            count,
            last_flagged_ms: 0,
        }
    }

    /// Outgoing and incoming of the same pair are separate parent rows.
    #[test]
    fn aggregate_splits_outgoing_and_incoming() {
        let mut flags = Flags::new();
        flags.insert(flag_key("aaa", "bbb"), flag(1));
        let mut meta_map = BTreeMap::new();
        meta_map.insert("aaa".into(), meta("Alpha", "ArtA", false, true));
        meta_map.insert("bbb".into(), meta("Beta", "ArtB", true, false));

        let rows = aggregate_flags(&flags, &meta_map, &Dismissed::new());
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].role, ROLE_OUTGOING);
        assert_eq!(rows[0].track_hash, "aaa");
        assert_eq!(rows[0].title, "Alpha");
        assert!(rows[0].low_confidence); // outro
        assert_eq!(rows[0].partners.len(), 1);
        assert_eq!(rows[0].partners[0].track_hash, "bbb");
        assert_eq!(rows[0].path.as_deref(), Some("/music/Alpha.flac"));
        assert!(rows[0].analyzed);
        assert_eq!(rows[0].intro_bars, Some(16));
        assert_eq!(rows[0].outro_structure_bars, Some(32));
        assert_eq!(rows[0].outro_bars, Some(48));

        assert_eq!(rows[1].role, ROLE_INCOMING);
        assert_eq!(rows[1].track_hash, "bbb");
        assert_eq!(rows[1].title, "Beta");
        assert!(rows[1].low_confidence); // intro
        assert_eq!(rows[1].partners[0].track_hash, "aaa");
        assert!(rows[1].analyzed);
    }

    /// Multiple partners for one track×role sum into one parent count.
    #[test]
    fn aggregate_sums_counts_across_partners() {
        let mut flags = Flags::new();
        flags.insert(flag_key("aaa", "bbb"), flag(2));
        flags.insert(flag_key("aaa", "ccc"), flag(3));
        let mut meta_map = BTreeMap::new();
        meta_map.insert("aaa".into(), meta("Alpha", "", false, false));
        meta_map.insert("bbb".into(), meta("Beta", "", false, false));
        meta_map.insert("ccc".into(), meta("Gamma", "", false, false));

        let rows = aggregate_flags(&flags, &meta_map, &Dismissed::new());
        let out = rows
            .iter()
            .find(|r| r.track_hash == "aaa" && r.role == ROLE_OUTGOING)
            .expect("outgoing aaa");
        assert_eq!(out.count, 5);
        assert_eq!(out.partners.len(), 2);
        assert_eq!(out.partners[0].track_hash, "ccc");
        assert_eq!(out.partners[0].count, 3);
        assert_eq!(out.partners[1].track_hash, "bbb");
        assert_eq!(out.partners[1].count, 2);
    }

    /// Parent sort: count desc → outgoing before incoming → title asc.
    /// `last_flagged_ms` must not affect order.
    #[test]
    fn aggregate_sorts_by_count_role_title() {
        let mut flags = Flags::new();
        flags.insert(
            flag_key("aaa", "bbb"),
            TransitionFlag {
                count: 1,
                last_flagged_ms: 9_999,
            },
        );
        flags.insert(
            flag_key("ccc", "ddd"),
            TransitionFlag {
                count: 3,
                last_flagged_ms: 1,
            },
        );
        flags.insert(flag_key("bbb", "eee"), flag(1));
        let mut meta_map = BTreeMap::new();
        meta_map.insert("aaa".into(), meta("Alpha", "", false, false));
        meta_map.insert("bbb".into(), meta("Beta", "", false, false));
        meta_map.insert("ccc".into(), meta("Gamma", "", false, false));
        meta_map.insert("ddd".into(), meta("Delta", "", false, false));
        meta_map.insert("eee".into(), meta("Epsilon", "", false, false));

        let rows = aggregate_flags(&flags, &meta_map, &Dismissed::new());
        // count=3: ccc outgoing, ddd incoming
        // count=1: aaa outgoing, bbb outgoing (+incoming from aaa), eee incoming, …
        assert_eq!(rows[0].track_hash, "ccc");
        assert_eq!(rows[0].role, ROLE_OUTGOING);
        assert_eq!(rows[0].count, 3);
        assert_eq!(rows[1].track_hash, "ddd");
        assert_eq!(rows[1].role, ROLE_INCOMING);
        assert_eq!(rows[1].count, 3);

        // Among count=1 outgoing: Alpha before Beta (title asc); outgoing before incoming.
        let count1: Vec<_> = rows.iter().filter(|r| r.count == 1).collect();
        let outgoings: Vec<_> = count1
            .iter()
            .filter(|r| r.role == ROLE_OUTGOING)
            .map(|r| r.title.as_str())
            .collect();
        assert_eq!(outgoings, vec!["Alpha", "Beta"]);
        assert!(count1
            .iter()
            .position(|r| r.role == ROLE_OUTGOING)
            .unwrap()
            < count1
                .iter()
                .position(|r| r.role == ROLE_INCOMING)
                .unwrap());
    }

    #[test]
    fn aggregate_marks_missing_hashes() {
        let mut flags = Flags::new();
        flags.insert(flag_key("aaa", "zzz"), flag(2));
        let mut meta_map = BTreeMap::new();
        meta_map.insert(
            "aaa".into(),
            meta("Alpha", "Art", false, true),
        );

        let rows = aggregate_flags(&flags, &meta_map, &Dismissed::new());
        let missing = rows
            .iter()
            .find(|r| r.track_hash == "zzz")
            .expect("missing incoming");
        assert!(missing.missing);
        assert_eq!(missing.title, MISSING_TITLE);
        assert!(!missing.low_confidence); // never ⚠ on missing
        assert_eq!(missing.role, ROLE_INCOMING);
        assert!(!missing.analyzed);
        assert_eq!(missing.path, None);
        assert_eq!(missing.intro_bars, None);
        assert_eq!(missing.outro_structure_bars, None);
        assert_eq!(missing.outro_bars, None);
        assert!(!missing.intro_manual);
        assert!(!missing.outro_manual);

        let out = rows
            .iter()
            .find(|r| r.track_hash == "aaa")
            .expect("outgoing aaa");
        assert!(!out.missing);
        assert!(out.low_confidence);
        assert!(out.analyzed);
        assert_eq!(out.partners[0].track_hash, "zzz");
        assert!(out.partners[0].missing);
        assert_eq!(out.partners[0].title, MISSING_TITLE);
    }

    /// Dismissing one side of a pair hides only that row; flags stay intact.
    #[test]
    fn aggregate_hides_dismissed_row_only() {
        let mut flags = Flags::new();
        flags.insert(flag_key("aaa", "bbb"), flag(1));
        let mut meta_map = BTreeMap::new();
        meta_map.insert("aaa".into(), meta("Alpha", "", false, false));
        meta_map.insert("bbb".into(), meta("Beta", "", false, false));

        let rows = aggregate_flags(&flags, &meta_map, &Dismissed::new());
        assert_eq!(rows.len(), 2);

        let mut dismissed = Dismissed::new();
        dismissed.insert(dismiss_key("aaa", ROLE_OUTGOING));
        let rows = aggregate_flags(&flags, &meta_map, &dismissed);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].track_hash, "bbb");
        assert_eq!(rows[0].role, ROLE_INCOMING);
        assert!(flags.contains_key(&flag_key("aaa", "bbb")));
        assert_eq!(flags[&flag_key("aaa", "bbb")].count, 1);
    }

    #[test]
    fn aggregate_hides_both_dismissed_rows() {
        let mut flags = Flags::new();
        flags.insert(flag_key("aaa", "bbb"), flag(1));
        let mut meta_map = BTreeMap::new();
        meta_map.insert("aaa".into(), meta("Alpha", "", false, false));
        meta_map.insert("bbb".into(), meta("Beta", "", false, false));

        let mut dismissed = Dismissed::new();
        dismissed.insert(dismiss_key("aaa", ROLE_OUTGOING));
        dismissed.insert(dismiss_key("bbb", ROLE_INCOMING));
        assert!(aggregate_flags(&flags, &meta_map, &dismissed).is_empty());
        assert!(flags.contains_key(&flag_key("aaa", "bbb")));
    }

    #[test]
    fn dismissed_round_trip() {
        let dir = TempDir::new("dismissed-roundtrip");
        let mut dismissed = Dismissed::new();
        dismissed.insert(dismiss_key("aaa", ROLE_OUTGOING));
        dismissed.insert(dismiss_key("bbb", ROLE_INCOMING));
        save_dismissed(&dir.0, &dismissed).unwrap();
        assert_eq!(load_dismissed(&dir.0), dismissed);
    }

    #[test]
    fn missing_dismissed_file_is_empty() {
        let dir = TempDir::new("dismissed-missing");
        assert!(load_dismissed(&dir.0).is_empty());
    }

    #[test]
    fn corrupt_dismissed_file_is_empty_not_a_panic() {
        let dir = TempDir::new("dismissed-corrupt");
        fs::write(dir.0.join(DISMISSED_FILE), b"{not json").unwrap();
        assert!(load_dismissed(&dir.0).is_empty());
    }

    /// Partners: count desc, then title asc.
    #[test]
    fn aggregate_sorts_partners_by_count_then_title() {
        let mut flags = Flags::new();
        flags.insert(flag_key("aaa", "bbb"), flag(2));
        flags.insert(flag_key("aaa", "ccc"), flag(2));
        flags.insert(flag_key("aaa", "ddd"), flag(5));
        let mut meta_map = BTreeMap::new();
        meta_map.insert("aaa".into(), meta("Alpha", "", false, false));
        meta_map.insert("bbb".into(), meta("Zulu", "", false, false));
        meta_map.insert("ccc".into(), meta("Mike", "", false, false));
        meta_map.insert("ddd".into(), meta("Delta", "", false, false));

        let rows = aggregate_flags(&flags, &meta_map, &Dismissed::new());
        let out = rows
            .iter()
            .find(|r| r.role == ROLE_OUTGOING && r.track_hash == "aaa")
            .expect("outgoing");
        assert_eq!(
            out.partners
                .iter()
                .map(|p| (p.title.as_str(), p.count))
                .collect::<Vec<_>>(),
            vec![("Delta", 5), ("Mike", 2), ("Zulu", 2)]
        );
    }

    #[test]
    fn aggregate_empty_flags_is_empty() {
        let flags = Flags::new();
        let meta_map = BTreeMap::new();
        assert!(aggregate_flags(&flags, &meta_map, &Dismissed::new()).is_empty());
    }
}
