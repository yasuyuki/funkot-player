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
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use symphonia::core::formats::FormatOptions;
use symphonia::core::formats::probe::Hint;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{MetadataOptions, StandardTag};

const QUEUE_FILE: &str = "queue.json";
const LIBRARY_FILE: &str = "library.json";
const FLAGS_FILE: &str = "flags.json";
const DISMISSED_FILE: &str = "dismissed.json";
const META_FILE: &str = "meta.json";
const SESSION_FILE: &str = "session.json";
const SETTINGS_FILE: &str = "settings.json";
const HASH_INDEX_FILE: &str = "hash-index.json";

/// Metadata bundled with a feedback ZIP (`share_feedback`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FeedbackMeta {
    pub version_name: String,
    pub version_code: u32,
    pub funkot_core_git: String,
    pub device_model: String,
    pub sent_at: String,
}

/// Seconds since UNIX epoch → `YYYY-MM-DDTHH:MM:SSZ` (UTC; leap seconds ignored).
pub fn utc_rfc3339_from_unix_secs(secs: u64) -> String {
    const SECONDS_PER_DAY: u64 = 86_400;
    let days = secs / SECONDS_PER_DAY;
    let rem = secs % SECONDS_PER_DAY;
    let hour = rem / 3_600;
    let minute = (rem % 3_600) / 60;
    let second = rem % 60;
    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Current UTC time as RFC3339 with second precision.
pub fn utc_rfc3339_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    utc_rfc3339_from_unix_secs(secs)
}

/// `2026-08-05T13:37:00Z` → `20260805T133700Z` for feedback ZIP filenames.
pub fn feedback_filename_stamp(sent_at: &str) -> String {
    sent_at.replace('-', "").replace(':', "")
}

/// Days since 1970-01-01 (UTC) → `(year, month, day)`.
fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year as i32, m as u32, d as u32)
}

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

/// Playback state restored across a restart: which tracks were already
/// mid-flight (out of `pending` but not yet finished playing) and whether
/// the transport was paused.
///
/// Deliberately does not include a position within `in_flight[0]` — a
/// restart always resumes that track from the top. `session.json` is not in
/// [`migrate_from`]'s file list: unlike `queue.json`/`library.json`/
/// `flags.json`, it never existed at the old cache-dir location this app
/// once used, so there is nothing to rescue.
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Session {
    /// Tracks `HostSource::next` (`src-tauri/src/queue.rs`) has already
    /// popped from `pending` but that had not finished playing as of the
    /// last save. Index `0` is the engine's active track; anything after it
    /// is reserved ahead of it. These never appear in `queue.json` (that
    /// file mirrors `pending` only), which is exactly why a plain restart
    /// used to lose the first two tracks — see [`restored_pending`].
    #[serde(default)]
    pub in_flight: Vec<PathBuf>,
    #[serde(default)]
    pub paused: bool,
}

impl Session {
    pub const fn new() -> Self {
        Self {
            in_flight: Vec::new(),
            paused: false,
        }
    }
}

/// Load the session previously saved under `dir`.
///
/// Missing or corrupt → [`Session::new`] (same policy as [`load_flags`] /
/// [`load_dismissed`]): losing a restart's worth of "what was playing" is
/// recoverable, refusing to launch is not.
pub fn load_session(dir: &Path) -> Session {
    let bytes = match fs::read(dir.join(SESSION_FILE)) {
        Ok(b) => b,
        Err(_) => return Session::new(),
    };
    match serde_json::from_slice(&bytes) {
        Ok(session) => session,
        Err(e) => {
            log::warn!("{SESSION_FILE} is unreadable, starting fresh: {e}");
            Session::new()
        }
    }
}

/// Persist `session` under `dir`, overwriting any previous save.
pub fn save_session(dir: &Path, session: &Session) -> io::Result<()> {
    let json = serde_json::to_vec_pretty(session)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(dir.join(SESSION_FILE), json)
}

/// User-configurable app settings (`settings.json`).
///
/// `music_dir`, when set, is the folder the listener picked via
/// `set_music_dir` (desktop only); `None` means no folder has been chosen
/// yet (`music_dir_needed`). An unreadable configured path is left in this
/// file — `resolve_music_dir` reports it as needed/unavailable without
/// clearing the setting.
///
/// `allow_non_funkot` is read/written on every platform (library enqueue and
/// folder-drain gate).
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub music_dir: Option<PathBuf>,
    /// When `false` (default), analysed non-Funkot tracks cannot be enqueued
    /// and are skipped by folder drain. Greying in the library is independent.
    #[serde(default)]
    pub allow_non_funkot: bool,
}

/// Load settings previously saved under `dir`.
///
/// Missing or corrupt → [`Settings::default`] (same policy as
/// [`load_session`] / [`load_flags`]): losing a folder choice is
/// recoverable, refusing to launch is not. A missing file is expected on
/// every first run and stays silent; a corrupt one logs a warning.
pub fn load_settings(dir: &Path) -> Settings {
    let bytes = match fs::read(dir.join(SETTINGS_FILE)) {
        Ok(b) => b,
        Err(_) => return Settings::default(),
    };
    match serde_json::from_slice(&bytes) {
        Ok(settings) => settings,
        Err(e) => {
            log::warn!("{SETTINGS_FILE} is unreadable, using defaults: {e}");
            Settings::default()
        }
    }
}

/// Persist `settings` under `dir`, overwriting any previous save.
pub fn save_settings(dir: &Path, settings: &Settings) -> io::Result<()> {
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(dir.join(SETTINGS_FILE), json)
}

/// Build the pending queue to restore after a restart: `in_flight` first (the
/// engine's active track, then anything already reserved ahead of it), then
/// whatever `queue.json` still had. `exists` drops paths the library no
/// longer has (moved/deleted while the app was closed).
///
/// Paths repeated across the two inputs keep only their first occurrence.
/// That is not a defensive nicety: `HostSource::next` (`src-tauri/src/
/// queue.rs`) pops from `pending`, then calls `on_pending_consumed` (which
/// rewrites `queue.json` without that entry) and *then* `on_reserved` (which
/// appends it to `in_flight`), in that order. A process death between those
/// two calls leaves the same path in both `queue.json` and `in_flight` — or,
/// symmetrically, in neither — and it is the double-listed case this
/// dedupes. The dropped-from-both case is not something this function can
/// fix; its window is microsecond-scale, and losing at most one track to it
/// is accepted.
pub fn restored_pending(
    in_flight: &[PathBuf],
    saved_queue: &[PathBuf],
    exists: impl Fn(&Path) -> bool,
) -> Vec<PathBuf> {
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();
    in_flight
        .iter()
        .chain(saved_queue.iter())
        .filter(|p| exists(p))
        .filter(|p| seen.insert((*p).clone()))
        .cloned()
        .collect()
}

/// Removes `revoked` from `in_flight` after `queue::edit_displayed`'s
/// `revoke` closure pulled it back out of the engine (`reorder`/`dequeue` in
/// `src-tauri/src/lib.rs`) and returned it to `pending`. `in_flight` no
/// longer reflects reality for that entry once that happens, and leaving it
/// there would resurrect a track the listener just reordered or removed the
/// next time `restored_pending` runs.
///
/// Removes the *last* matching entry, not the first. `in_flight` can
/// legitimately hold the same path twice — e.g. the same track queued twice
/// gives `in_flight = [X (now playing), X (reserved)]` — and a revoke always
/// undoes whichever instance was reserved *most recently*: the engine's
/// active track (`in_flight[0]`) is never what a revoke hands back, only
/// something reserved after it. Removing the first match instead could evict
/// the still-playing entry and lose the session's record of what is actually
/// on the speakers.
///
/// A no-op if `revoked` is not found in `in_flight` (should not happen if
/// `in_flight` and the engine's reserved slot stay in sync, but this
/// function is not the place to assert that).
pub fn retire_revoked(in_flight: &mut Vec<PathBuf>, revoked: &Path) {
    if let Some(pos) = in_flight.iter().rposition(|p| p.as_path() == revoked) {
        in_flight.remove(pos);
    }
}

/// Where to resume folder cycling (`DrainPolicy::ContinueFolder`,
/// `src-tauri/src/queue.rs`) after a restart. `tracks` must be sorted the
/// same way `start_impl` builds it.
///
/// Finds `last_reserved` in `tracks` and resumes right after it — wrapping to
/// `0` if it was the last entry, exactly like `HostSource::next`'s own
/// `(pos + 1) % tracks.len()` step, so a restart mid-cycle does not repeat or
/// skip a track. Returns `0` if `last_reserved` is `None` (nothing was ever
/// reserved) or not found in `tracks` (a library edit removed it since).
///
/// `last_reserved` is meant to be `in_flight`'s *last* entry, not its first
/// (the active track): by the time this runs the folder-drain and pending
/// origins of `in_flight`'s entries can no longer be told apart (both are
/// recorded the same way, via `on_reserved`), so this cannot resume exactly
/// where the folder cycle left off in every case. But "continue after
/// whatever was reserved most recently" is still correct whenever the
/// restart really was mid-folder-cycle, and even when it was not (the last
/// reservation came from `pending`) it is strictly better than the old
/// `pos: 0`, which silently rewound to the folder's start every single time.
pub fn restored_folder_pos(tracks: &[PathBuf], last_reserved: Option<&Path>) -> usize {
    let Some(last_reserved) = last_reserved else {
        return 0;
    };
    match tracks.iter().position(|p| p.as_path() == last_reserved) {
        Some(idx) => (idx + 1) % tracks.len(),
        None => 0,
    }
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
    /// Manual Funkot / non-Funkot override. `None` follows analysis
    /// `is_funkot`. Not written by the current UI (data model only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub funkot: Option<bool>,
}

/// Effective Funkot flag: `override.funkot` when set, else analysis.
pub fn effective_is_funkot(analysis_is_funkot: bool, override_funkot: Option<bool>) -> bool {
    override_funkot.unwrap_or(analysis_is_funkot)
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

/// One file's content-hash cache entry, keyed by path in [`HashIndex`].
///
/// `mtime_ms` + `len` are a cheap fingerprint so a library rescan can skip
/// re-reading file bytes when nothing has changed on disk.
///
/// When `tags_cached` is true, `title`/`artist` were probed (both `None` means
/// the file has no usable tags). Older `hash-index.json` entries lack these
/// fields and deserialize as `tags_cached: false`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct HashIndexEntry {
    pub mtime_ms: u64,
    pub len: u64,
    pub hash: String,
    /// When true, `title`/`artist` were probed and may be stored (both None = no tags).
    #[serde(default)]
    pub tags_cached: bool,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
}

/// Path → content hash, with mtime/size so unchanged files skip re-hashing.
pub type HashIndex = BTreeMap<String, HashIndexEntry>;

/// Hash + embedded tags for one library file after [`resolve_library_file`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedLibraryFile {
    pub hash: String,
    pub title: Option<String>,
    pub artist: Option<String>,
}

/// Load the content-hash index saved under `dir`.
///
/// Missing or corrupt → empty map (same policy as [`load_overrides`]).
pub fn load_hash_index(dir: &Path) -> HashIndex {
    let bytes = match fs::read(dir.join(HASH_INDEX_FILE)) {
        Ok(b) => b,
        Err(_) => return HashIndex::new(),
    };
    match serde_json::from_slice(&bytes) {
        Ok(map) => map,
        Err(e) => {
            log::warn!("{HASH_INDEX_FILE} is unreadable, starting empty: {e}");
            HashIndex::new()
        }
    }
}

/// Persist `index` under `dir`, overwriting any previous save.
pub fn save_hash_index(dir: &Path, index: &HashIndex) -> io::Result<()> {
    let json = serde_json::to_vec_pretty(index)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(dir.join(HASH_INDEX_FILE), json)
}

/// `metadata.modified()` as UNIX-epoch milliseconds, plus file length.
///
/// `None` when either side is unavailable — callers treat that as an index miss.
fn file_mtime_ms_and_len(path: &Path) -> Option<(u64, u64)> {
    let meta = fs::metadata(path).ok()?;
    let len = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some((mtime_ms, len))
}

/// Probe embedded title/artist via symphonia (open + metadata only).
///
/// Successful probes include "no tags" (`Ok((None, None))`). I/O / probe
/// errors are `Err` so callers can avoid marking `tags_cached`.
pub fn probe_audio_tags(path: &Path) -> Result<(Option<String>, Option<String>), String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| e.to_string())?;
    let mut title = None;
    let mut artist = None;
    if let Some(rev) = format.metadata().skip_to_latest() {
        for tag in &rev.media.tags {
            match &tag.std {
                Some(StandardTag::TrackTitle(s)) if title.is_none() => {
                    let t = s.trim();
                    if !t.is_empty() {
                        title = Some(t.to_string());
                    }
                }
                Some(StandardTag::Artist(s)) if artist.is_none() => {
                    let a = s.trim();
                    if !a.is_empty() {
                        artist = Some(a.to_string());
                    }
                }
                _ => {}
            }
        }
    }
    Ok((title, artist))
}

/// Return `path`'s content hash, reusing [`HashIndex`] when mtime+size match.
///
/// Does not probe or clear tags on a fingerprint hit. On miss, inserts with
/// `tags_cached: false` (hash-only; library refresh fills tags later).
// ponytail: mtime+size fingerprint can disagree after same-mtime overwrite; re-verify content if needed.
pub fn resolve_content_hash(path: &Path, index: &mut HashIndex) -> io::Result<String> {
    let key = path.to_string_lossy().into_owned();
    let fingerprint = file_mtime_ms_and_len(path);

    if let Some((mtime_ms, len)) = fingerprint {
        if let Some(entry) = index.get(&key) {
            if entry.mtime_ms == mtime_ms && entry.len == len {
                return Ok(entry.hash.clone());
            }
        }
    }

    let hash = funkot_core::cache::content_hash(path)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

    if let Some((mtime_ms, len)) = fingerprint {
        index.insert(
            key,
            HashIndexEntry {
                mtime_ms,
                len,
                hash: hash.clone(),
                tags_cached: false,
                title: None,
                artist: None,
            },
        );
    }
    Ok(hash)
}

/// Resolve content hash and embedded tags for a library scan, updating `index`
/// in place. Does not persist to disk.
///
/// - Fingerprint miss → content-hash + tags probe → write full entry
/// - Fingerprint hit + `tags_cached` → no file open; return stored hash/tags
/// - Fingerprint hit + `!tags_cached` → skip content-hash; probe tags only
pub fn resolve_library_file(
    path: &Path,
    index: &mut HashIndex,
) -> io::Result<ResolvedLibraryFile> {
    let key = path.to_string_lossy().into_owned();
    let fingerprint = file_mtime_ms_and_len(path);

    if let Some((mtime_ms, len)) = fingerprint {
        if let Some(entry) = index.get(&key) {
            if entry.mtime_ms == mtime_ms && entry.len == len {
                if entry.tags_cached {
                    return Ok(ResolvedLibraryFile {
                        hash: entry.hash.clone(),
                        title: entry.title.clone(),
                        artist: entry.artist.clone(),
                    });
                }
                let hash = entry.hash.clone();
                match probe_audio_tags(path) {
                    Ok((title, artist)) => {
                        index.insert(
                            key,
                            HashIndexEntry {
                                mtime_ms,
                                len,
                                hash: hash.clone(),
                                tags_cached: true,
                                title: title.clone(),
                                artist: artist.clone(),
                            },
                        );
                        return Ok(ResolvedLibraryFile {
                            hash,
                            title,
                            artist,
                        });
                    }
                    Err(_) => {
                        return Ok(ResolvedLibraryFile {
                            hash,
                            title: None,
                            artist: None,
                        });
                    }
                }
            }
        }
    }

    let hash = funkot_core::cache::content_hash(path)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
    let (title, artist, tags_cached) = match probe_audio_tags(path) {
        Ok((t, a)) => (t, a, true),
        Err(_) => (None, None, false),
    };

    if let Some((mtime_ms, len)) = fingerprint {
        index.insert(
            key,
            HashIndexEntry {
                mtime_ms,
                len,
                hash: hash.clone(),
                tags_cached,
                title: title.clone(),
                artist: artist.clone(),
            },
        );
    }
    Ok(ResolvedLibraryFile {
        hash,
        title,
        artist,
    })
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

const EMPTY_JSON_OBJECT: &[u8] = b"{}";

/// Read a JSON file's raw bytes, or `{}` when missing / unreadable.
fn read_json_or_empty_object(path: &Path) -> Vec<u8> {
    match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => EMPTY_JSON_OBJECT.to_vec(),
    }
}

fn stored_zip_options() -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
}

/// Write `library.json`, `flags.json`, and `meta.json` entries into `dest` (Stored).
///
/// Callers that need a consistent snapshot with concurrent saves should hold
/// `SAVE_LOCK` around [`write_feedback_zip`].
pub fn write_feedback_zip_bytes(
    library_json: &[u8],
    flags_json: &[u8],
    meta_json: &[u8],
    dest: &Path,
) -> io::Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = fs::File::create(dest)?;
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file(LIBRARY_FILE, stored_zip_options())
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    zip.write_all(library_json)?;
    zip.start_file(FLAGS_FILE, stored_zip_options())
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    zip.write_all(flags_json)?;
    zip.start_file(META_FILE, stored_zip_options())
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    zip.write_all(meta_json)?;
    zip.finish()
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    Ok(())
}

/// Snapshot `library.json` / `flags.json` from `data_dir` into a ZIP at `dest`.
///
/// Missing or unreadable sources become an `{}` entry. Does not touch
/// `dismissed.json` / `queue.json`, and never moves or deletes the originals.
pub fn write_feedback_zip(data_dir: &Path, dest: &Path, meta: &FeedbackMeta) -> io::Result<()> {
    let library = read_json_or_empty_object(&data_dir.join(LIBRARY_FILE));
    let flags = read_json_or_empty_object(&data_dir.join(FLAGS_FILE));
    let meta_json = serde_json::to_vec_pretty(meta)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    write_feedback_zip_bytes(&library, &flags, &meta_json, dest)
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
    /// Absolute path when the partner is still in the library; API-only (not
    /// persisted in `flags.json`).
    pub path: Option<String>,
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
                    let (ptitle, _, _, _, pmissing, ppath, _, _, _, _, _, _) =
                        resolve(&partner_hash);
                    FlagPartner {
                        track_hash: partner_hash,
                        title: ptitle,
                        count: pcount,
                        missing: pmissing,
                        path: ppath,
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
                ..Default::default()
            },
        );
        o.insert(
            "bbb".into(),
            BarOverride {
                outro_structure_bars: Some(16),
                ..Default::default()
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
    fn hash_index_round_trip() {
        let dir = TempDir::new("hash-index-roundtrip");
        let mut index = HashIndex::new();
        index.insert(
            "/music/a.flac".into(),
            HashIndexEntry {
                mtime_ms: 1_700_000_000_000,
                len: 4096,
                hash: "abc".into(),
                tags_cached: true,
                title: Some("A".into()),
                artist: Some("Artist".into()),
            },
        );
        save_hash_index(&dir.0, &index).unwrap();
        assert_eq!(load_hash_index(&dir.0), index);
    }

    #[test]
    fn hash_index_old_entry_deserializes_without_tags() {
        let dir = TempDir::new("hash-index-old-format");
        fs::write(
            dir.0.join(HASH_INDEX_FILE),
            br#"{"/music/a.flac":{"mtime_ms":1,"len":10,"hash":"abc"}}"#,
        )
        .unwrap();
        let loaded = load_hash_index(&dir.0);
        let entry = &loaded["/music/a.flac"];
        assert_eq!(entry.hash, "abc");
        assert!(!entry.tags_cached);
        assert!(entry.title.is_none());
        assert!(entry.artist.is_none());
    }

    #[test]
    fn missing_hash_index_file_is_empty() {
        let dir = TempDir::new("hash-index-missing");
        assert!(load_hash_index(&dir.0).is_empty());
    }

    #[test]
    fn corrupt_hash_index_file_is_empty_not_a_panic() {
        let dir = TempDir::new("hash-index-corrupt");
        fs::write(dir.0.join(HASH_INDEX_FILE), b"{not json").unwrap();
        assert!(load_hash_index(&dir.0).is_empty());
    }

    /// Second resolve with unchanged mtime+len must not re-read file bytes.
    #[test]
    fn resolve_reuses_cached_hash_when_mtime_and_len_match() {
        let dir = TempDir::new("hash-index-hit");
        let path = dir.0.join("track.wav");
        fs::write(&path, vec![1u8; 256]).unwrap();

        let mut index = HashIndex::new();
        let first = resolve_content_hash(&path, &mut index).unwrap();
        assert_eq!(index.len(), 1);

        // Same size, different bytes; restore mtime so the fingerprint still hits.
        let mtime = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, vec![9u8; 256]).unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(mtime)
            .unwrap();

        let second = resolve_content_hash(&path, &mut index).unwrap();
        assert_eq!(first, second);
        // Fresh content_hash would see the new bytes — proves we skipped it.
        let fresh = funkot_core::cache::content_hash(&path).unwrap();
        assert_ne!(first, fresh);
    }

    #[test]
    fn resolve_rehashes_when_len_changes() {
        let dir = TempDir::new("hash-index-len");
        let path = dir.0.join("track.wav");
        fs::write(&path, vec![1u8; 128]).unwrap();

        let mut index = HashIndex::new();
        let first = resolve_content_hash(&path, &mut index).unwrap();

        fs::write(&path, vec![1u8; 256]).unwrap();
        let second = resolve_content_hash(&path, &mut index).unwrap();
        assert_ne!(first, second);
        let key = path.to_string_lossy().into_owned();
        assert_eq!(index[&key].len, 256);
        assert_eq!(index[&key].hash, second);
    }

    #[test]
    fn resolve_rehashes_when_mtime_changes() {
        let dir = TempDir::new("hash-index-mtime");
        let path = dir.0.join("track.wav");
        fs::write(&path, vec![1u8; 128]).unwrap();

        let mut index = HashIndex::new();
        let first = resolve_content_hash(&path, &mut index).unwrap();

        // Same bytes, bumped mtime → miss → rehash; hash value stays equal but
        // the index entry's mtime_ms must update.
        let old_mtime_ms = index[&path.to_string_lossy().into_owned()].mtime_ms;
        let later = std::time::SystemTime::UNIX_EPOCH
            + std::time::Duration::from_millis(old_mtime_ms + 5_000);
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(later)
            .unwrap();

        let second = resolve_content_hash(&path, &mut index).unwrap();
        assert_eq!(first, second);
        let entry = &index[&path.to_string_lossy().into_owned()];
        assert_eq!(entry.hash, second);
        assert_eq!(entry.mtime_ms, old_mtime_ms + 5_000);
    }

    #[test]
    fn save_hash_index_after_prune_drops_unseen_paths() {
        let dir = TempDir::new("hash-index-prune");
        let mut index = HashIndex::new();
        index.insert(
            "/music/kept.flac".into(),
            HashIndexEntry {
                mtime_ms: 1,
                len: 10,
                hash: "kept".into(),
                tags_cached: false,
                title: None,
                artist: None,
            },
        );
        index.insert(
            "/music/gone.flac".into(),
            HashIndexEntry {
                mtime_ms: 2,
                len: 20,
                hash: "gone".into(),
                tags_cached: false,
                title: None,
                artist: None,
            },
        );
        index.retain(|path, _| path == "/music/kept.flac");
        save_hash_index(&dir.0, &index).unwrap();
        let loaded = load_hash_index(&dir.0);
        assert_eq!(loaded.len(), 1);
        assert!(loaded.contains_key("/music/kept.flac"));
        assert!(!loaded.contains_key("/music/gone.flac"));
    }

    /// Fingerprint + tags_cached hit must not open the file: changed bytes with
    /// restored mtime still return the stored hash and title.
    #[test]
    fn resolve_library_reuses_tags_when_fingerprint_and_tags_cached() {
        let dir = TempDir::new("hash-index-tags-hit");
        let path = dir.0.join("track.wav");
        fs::write(&path, vec![1u8; 256]).unwrap();
        let (mtime_ms, len) = file_mtime_ms_and_len(&path).unwrap();
        let key = path.to_string_lossy().into_owned();

        let mut index = HashIndex::new();
        index.insert(
            key.clone(),
            HashIndexEntry {
                mtime_ms,
                len,
                hash: "stale-hash".into(),
                tags_cached: true,
                title: Some("Cached Title".into()),
                artist: Some("Cached Artist".into()),
            },
        );

        let mtime = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, vec![9u8; 256]).unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(mtime)
            .unwrap();

        let resolved = resolve_library_file(&path, &mut index).unwrap();
        assert_eq!(resolved.hash, "stale-hash");
        assert_eq!(resolved.title.as_deref(), Some("Cached Title"));
        assert_eq!(resolved.artist.as_deref(), Some("Cached Artist"));
        // Fresh content_hash would see the new bytes — proves we skipped open
        // for hashing; stored title would be wiped by a real probe of this
        // non-audio payload, so keeping it proves tags were not re-probed.
        let fresh = funkot_core::cache::content_hash(&path).unwrap();
        assert_ne!(resolved.hash, fresh);
        assert_eq!(index[&key].title.as_deref(), Some("Cached Title"));
    }

    /// Tiny PCM WAV (no tags) so `probe_audio_tags` succeeds with both None.
    fn write_silent_wav(path: &Path, fill: u8) {
        let sample_rate = 8_000u32;
        let channels = 1u16;
        let bits = 16u16;
        let n_samples = 64u32;
        let data_size = n_samples * (bits as u32 / 8) * u32::from(channels);
        let mut buf = Vec::with_capacity(44 + data_size as usize);
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&(36 + data_size).to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
        buf.extend_from_slice(&channels.to_le_bytes());
        buf.extend_from_slice(&sample_rate.to_le_bytes());
        let byte_rate = sample_rate * u32::from(channels) * (u32::from(bits) / 8);
        buf.extend_from_slice(&byte_rate.to_le_bytes());
        let block_align = channels * bits / 8;
        buf.extend_from_slice(&block_align.to_le_bytes());
        buf.extend_from_slice(&bits.to_le_bytes());
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_size.to_le_bytes());
        buf.extend(std::iter::repeat(fill).take(data_size as usize));
        fs::write(path, buf).unwrap();
    }

    /// Pre-tags index entry: fingerprint hit still skips content_hash, probes
    /// tags once, and upgrades the entry to `tags_cached`.
    #[test]
    fn resolve_library_upgrades_old_entry_tags_without_rehash() {
        let dir = TempDir::new("hash-index-tags-upgrade");
        let path = dir.0.join("track.wav");
        write_silent_wav(&path, 1);
        let (mtime_ms, len) = file_mtime_ms_and_len(&path).unwrap();
        let key = path.to_string_lossy().into_owned();

        let mut index = HashIndex::new();
        index.insert(
            key.clone(),
            HashIndexEntry {
                mtime_ms,
                len,
                hash: "kept-hash".into(),
                tags_cached: false,
                title: None,
                artist: None,
            },
        );

        let mtime = fs::metadata(&path).unwrap().modified().unwrap();
        write_silent_wav(&path, 9);
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(mtime)
            .unwrap();

        let resolved = resolve_library_file(&path, &mut index).unwrap();
        assert_eq!(resolved.hash, "kept-hash");
        let fresh = funkot_core::cache::content_hash(&path).unwrap();
        assert_ne!(resolved.hash, fresh);

        let entry = &index[&key];
        assert!(entry.tags_cached);
        assert_eq!(entry.hash, "kept-hash");
        // Tagless WAV: both None is still a successful probe.
        assert!(entry.title.is_none());
        assert!(entry.artist.is_none());
    }

    /// `resolve_content_hash` miss must not wipe a prior tags-cached entry's
    /// fields only when fingerprint still hits — and on miss inserts
    /// tags_cached: false without inventing tags.
    #[test]
    fn resolve_content_hash_miss_inserts_without_tags() {
        let dir = TempDir::new("hash-index-hash-only-miss");
        let path = dir.0.join("track.wav");
        fs::write(&path, vec![1u8; 128]).unwrap();

        let mut index = HashIndex::new();
        let hash = resolve_content_hash(&path, &mut index).unwrap();
        let key = path.to_string_lossy().into_owned();
        let entry = &index[&key];
        assert_eq!(entry.hash, hash);
        assert!(!entry.tags_cached);
        assert!(entry.title.is_none());
        assert!(entry.artist.is_none());
    }

    /// Fingerprint hit on `resolve_content_hash` must leave tags fields alone.
    #[test]
    fn resolve_content_hash_hit_preserves_tags() {
        let dir = TempDir::new("hash-index-hash-preserves-tags");
        let path = dir.0.join("track.wav");
        fs::write(&path, vec![1u8; 128]).unwrap();
        let (mtime_ms, len) = file_mtime_ms_and_len(&path).unwrap();
        let key = path.to_string_lossy().into_owned();

        let mut index = HashIndex::new();
        index.insert(
            key.clone(),
            HashIndexEntry {
                mtime_ms,
                len,
                hash: "h".into(),
                tags_cached: true,
                title: Some("T".into()),
                artist: Some("A".into()),
            },
        );

        assert_eq!(resolve_content_hash(&path, &mut index).unwrap(), "h");
        let entry = &index[&key];
        assert!(entry.tags_cached);
        assert_eq!(entry.title.as_deref(), Some("T"));
        assert_eq!(entry.artist.as_deref(), Some("A"));
    }

    #[test]
    fn migrate_moves_all_files_and_leaves_nothing_behind() {
        let old = TempDir::new("migrate-old");
        let new = TempDir::new("migrate-new");

        let mut queue: VecDeque<PathBuf> = VecDeque::new();
        queue.push_back(PathBuf::from("/music/a.flac"));
        save_queue(&old.0, &queue).unwrap();
        let mut o = Overrides::new();
        o.insert(
            "aaa".into(),
            BarOverride {
                intro_bars: Some(32),
                ..Default::default()
            },
        );
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
        assert_eq!(
            rows[0].partners[0].path.as_deref(),
            Some("/music/Beta.flac")
        );
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
        assert_eq!(out.partners[0].path, None);
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

    fn read_zip_entry(path: &Path, name: &str) -> Vec<u8> {
        let file = fs::File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut entry = archive.by_name(name).unwrap();
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut buf).unwrap();
        buf
    }

    /// Present files are stored under exact entry names; missing ones become `{}`.
    #[test]
    fn feedback_zip_stores_files_and_empty_object_fallback() {
        let dir = TempDir::new("feedback-zip");
        let library = br#"{"aaa":{"intro_bars":16}}"#;
        fs::write(dir.0.join(LIBRARY_FILE), library).unwrap();
        // flags.json deliberately absent → `{}`

        let meta = FeedbackMeta {
            version_name: "0.1.0".into(),
            version_code: 1000,
            funkot_core_git: "abc123def456".into(),
            device_model: "test-device".into(),
            sent_at: "2026-08-05T13:37:00Z".into(),
        };

        let dest = dir.0.join("out").join("funkot-feedback.zip");
        write_feedback_zip(&dir.0, &dest, &meta).unwrap();

        {
            let file = fs::File::open(&dest).unwrap();
            let archive = zip::ZipArchive::new(file).unwrap();
            assert_eq!(archive.len(), 3);
        }
        assert_eq!(read_zip_entry(&dest, LIBRARY_FILE), library);
        assert_eq!(read_zip_entry(&dest, FLAGS_FILE), b"{}");
        let parsed_meta: FeedbackMeta =
            serde_json::from_slice(&read_zip_entry(&dest, META_FILE)).unwrap();
        assert_eq!(parsed_meta, meta);
        assert!(!read_zip_entry(&dest, META_FILE)
            .windows(b"nickname".len())
            .any(|w| w == b"nickname"));
        // Originals stay put (flags was never created).
        assert_eq!(fs::read(dir.0.join(LIBRARY_FILE)).unwrap(), library);
        assert!(!dir.0.join(FLAGS_FILE).exists());
        assert!(!dir.0.join(QUEUE_FILE).exists());
        assert!(!dir.0.join(DISMISSED_FILE).exists());
    }

    #[test]
    fn utc_rfc3339_from_unix_secs_formats_epoch() {
        assert_eq!(
            utc_rfc3339_from_unix_secs(0),
            "1970-01-01T00:00:00Z"
        );
        assert_eq!(
            utc_rfc3339_from_unix_secs(86_400),
            "1970-01-02T00:00:00Z"
        );
        assert_eq!(
            utc_rfc3339_from_unix_secs(1_785_937_020),
            "2026-08-05T13:37:00Z"
        );
    }

    #[test]
    fn feedback_filename_stamp_strips_separators() {
        assert_eq!(
            feedback_filename_stamp("2026-08-05T13:37:00Z"),
            "20260805T133700Z"
        );
    }

    #[test]
    fn session_round_trips() {
        let dir = TempDir::new("session-roundtrip");
        let session = Session {
            in_flight: vec![
                PathBuf::from("/music/active.flac"),
                PathBuf::from("/music/reserved.flac"),
            ],
            paused: true,
        };
        save_session(&dir.0, &session).unwrap();
        assert_eq!(load_session(&dir.0), session);
    }

    #[test]
    fn missing_session_file_is_default() {
        let dir = TempDir::new("session-missing");
        assert_eq!(load_session(&dir.0), Session::new());
    }

    #[test]
    fn corrupt_session_file_is_default_not_a_panic() {
        let dir = TempDir::new("session-corrupt");
        fs::write(dir.0.join(SESSION_FILE), b"{not json").unwrap();
        assert_eq!(load_session(&dir.0), Session::new());
    }

    #[test]
    fn settings_missing_file_is_default() {
        let dir = TempDir::new("settings-missing");
        assert_eq!(load_settings(&dir.0), Settings::default());
    }

    #[test]
    fn settings_round_trip_music_dir() {
        let dir = TempDir::new("settings-roundtrip");
        let settings = Settings {
            music_dir: Some(PathBuf::from("/somewhere/Music")),
            ..Default::default()
        };
        save_settings(&dir.0, &settings).unwrap();
        assert_eq!(load_settings(&dir.0), settings);
    }

    #[test]
    fn settings_round_trip_allow_non_funkot() {
        let dir = TempDir::new("settings-allow-non-funkot");
        let settings = Settings {
            allow_non_funkot: true,
            ..Default::default()
        };
        save_settings(&dir.0, &settings).unwrap();
        assert_eq!(load_settings(&dir.0), settings);
        assert!(!Settings::default().allow_non_funkot);
    }

    #[test]
    fn settings_old_json_without_allow_non_funkot_defaults_false() {
        let dir = TempDir::new("settings-legacy");
        fs::write(
            dir.0.join(SETTINGS_FILE),
            br#"{"music_dir":"/somewhere/Music"}"#,
        )
        .unwrap();
        let loaded = load_settings(&dir.0);
        assert_eq!(
            loaded.music_dir.as_deref(),
            Some(Path::new("/somewhere/Music"))
        );
        assert!(!loaded.allow_non_funkot);
    }

    #[test]
    fn settings_corrupt_file_is_default() {
        let dir = TempDir::new("settings-corrupt");
        fs::write(dir.0.join(SETTINGS_FILE), b"{not json").unwrap();
        assert_eq!(load_settings(&dir.0), Settings::default());
    }

    #[test]
    fn bar_override_funkot_round_trip() {
        let dir = TempDir::new("override-funkot");
        let mut o = Overrides::new();
        o.insert(
            "hash".into(),
            BarOverride {
                funkot: Some(false),
                ..Default::default()
            },
        );
        save_overrides(&dir.0, &o).unwrap();
        let loaded = load_overrides(&dir.0);
        assert_eq!(loaded["hash"].funkot, Some(false));
        assert_eq!(
            effective_is_funkot(true, loaded["hash"].funkot),
            false
        );
        assert!(effective_is_funkot(true, None));
    }

    #[test]
    fn restored_pending_puts_in_flight_before_saved_queue() {
        let in_flight = vec![PathBuf::from("/music/active.flac")];
        let saved = vec![PathBuf::from("/music/next.flac")];
        let restored = restored_pending(&in_flight, &saved, |_| true);
        assert_eq!(
            restored,
            vec![
                PathBuf::from("/music/active.flac"),
                PathBuf::from("/music/next.flac"),
            ]
        );
    }

    /// A path saved on both sides (the `on_pending_consumed` /
    /// `on_reserved` ordering race) must only appear once, at the
    /// `in_flight` position.
    #[test]
    fn restored_pending_dedupes_keeping_first_occurrence() {
        let in_flight = vec![PathBuf::from("/music/a.flac")];
        let saved = vec![
            PathBuf::from("/music/a.flac"),
            PathBuf::from("/music/b.flac"),
        ];
        let restored = restored_pending(&in_flight, &saved, |_| true);
        assert_eq!(
            restored,
            vec![
                PathBuf::from("/music/a.flac"),
                PathBuf::from("/music/b.flac"),
            ]
        );
    }

    #[test]
    fn restored_pending_drops_paths_that_no_longer_exist() {
        let in_flight = vec![
            PathBuf::from("/music/gone.flac"),
            PathBuf::from("/music/still-here.flac"),
        ];
        let saved = vec![PathBuf::from("/music/also-gone.flac")];
        let restored = restored_pending(&in_flight, &saved, |p| {
            p == Path::new("/music/still-here.flac")
        });
        assert_eq!(restored, vec![PathBuf::from("/music/still-here.flac")]);
    }

    #[test]
    fn restored_pending_both_empty_is_empty() {
        assert!(restored_pending(&[], &[], |_| true).is_empty());
    }

    #[test]
    fn restored_folder_pos_finds_the_next_track() {
        let tracks = vec![
            PathBuf::from("/music/a.flac"),
            PathBuf::from("/music/b.flac"),
            PathBuf::from("/music/c.flac"),
        ];
        assert_eq!(
            restored_folder_pos(&tracks, Some(Path::new("/music/a.flac"))),
            1
        );
    }

    /// Resuming after the last track in the folder wraps back to the start,
    /// same as `HostSource::next`'s own wrap-around.
    #[test]
    fn restored_folder_pos_wraps_after_the_last_track() {
        let tracks = vec![
            PathBuf::from("/music/a.flac"),
            PathBuf::from("/music/b.flac"),
            PathBuf::from("/music/c.flac"),
        ];
        assert_eq!(
            restored_folder_pos(&tracks, Some(Path::new("/music/c.flac"))),
            0
        );
    }

    #[test]
    fn restored_folder_pos_falls_back_to_zero_when_not_found() {
        let tracks = vec![
            PathBuf::from("/music/a.flac"),
            PathBuf::from("/music/b.flac"),
        ];
        assert_eq!(
            restored_folder_pos(&tracks, Some(Path::new("/music/removed.flac"))),
            0
        );
    }

    #[test]
    fn restored_folder_pos_falls_back_to_zero_when_none() {
        let tracks = vec![PathBuf::from("/music/a.flac")];
        assert_eq!(restored_folder_pos(&tracks, None), 0);
    }

    /// The duplicate case `retire_revoked` exists for: the actively-playing
    /// entry at index `0` must survive, only the later reservation goes.
    #[test]
    fn retire_revoked_removes_the_last_match_not_the_first() {
        let mut in_flight = vec![
            PathBuf::from("/music/x.flac"),
            PathBuf::from("/music/x.flac"),
        ];
        retire_revoked(&mut in_flight, Path::new("/music/x.flac"));
        assert_eq!(in_flight, vec![PathBuf::from("/music/x.flac")]);
    }

    #[test]
    fn retire_revoked_with_no_match_leaves_in_flight_unchanged() {
        let mut in_flight = vec![
            PathBuf::from("/music/a.flac"),
            PathBuf::from("/music/b.flac"),
        ];
        retire_revoked(&mut in_flight, Path::new("/music/c.flac"));
        assert_eq!(
            in_flight,
            vec![PathBuf::from("/music/a.flac"), PathBuf::from("/music/b.flac")]
        );
    }

    #[test]
    fn retire_revoked_on_empty_in_flight_is_a_noop() {
        let mut in_flight: Vec<PathBuf> = Vec::new();
        retire_revoked(&mut in_flight, Path::new("/music/a.flac"));
        assert!(in_flight.is_empty());
    }

    #[test]
    fn retire_revoked_with_one_matching_element_empties_it() {
        let mut in_flight = vec![PathBuf::from("/music/a.flac")];
        retire_revoked(&mut in_flight, Path::new("/music/a.flac"));
        assert!(in_flight.is_empty());
    }
}
