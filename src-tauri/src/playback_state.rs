use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::playlists::{Catalog, LoadState, PlaylistError};
use crate::queue::QueueItem;
use crate::store::{Session, Settings};

const FILE_NAME: &str = "playback-state.json";
const LOCK_NAME: &str = "playlists.lock";
pub const PLAYBACK_STATE_SCHEMA_VERSION: u32 = 1;
#[cfg(test)]
thread_local! {
    static FAIL_PERSIST_STAGE: std::cell::Cell<Option<u8>> = const { std::cell::Cell::new(None) };
    static CRASH_STAGE: std::cell::Cell<Option<u8>> = const { std::cell::Cell::new(None) };
}
#[cfg(test)]
pub(crate) fn set_fail_persist_stage(stage: u8) {
    FAIL_PERSIST_STAGE.with(|failure| failure.set(Some(stage)));
}
#[cfg(test)]
pub(crate) fn set_crash_stage(stage: u8) {
    CRASH_STAGE.with(|cut| cut.set(Some(stage)));
}
#[cfg(test)]
fn fail_persist_stage(stage: u8) -> io::Result<()> {
    if FAIL_PERSIST_STAGE.with(|failure| {
        if failure.get() == Some(stage) {
            failure.set(None);
            true
        } else {
            false
        }
    }) {
        Err(io::Error::other("injected playback-state persist failure"))
    } else {
        Ok(())
    }
}
#[cfg(test)]
fn park_at_crash_stage(stage: u8) {
    if CRASH_STAGE.with(|cut| cut.get() == Some(stage)) {
        let mut stdout = io::stdout();
        writeln!(stdout, "playback-cut:{stage}").expect("write crash-cut handshake");
        stdout.flush().expect("flush crash-cut handshake");
        loop {
            std::thread::park();
        }
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PlaybackState {
    pub schema_version: u32,
    pub revision: u64,
    pub queue: Vec<QueueItem>,
    pub session: Session,
    pub catalog: Catalog,
    pub settings: Settings,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlaybackRecoveryStatus {
    Ready,
    LegacyNormalConflict {
        token: u64,
        queue_file_items: usize,
        catalog_normal_items: usize,
    },
    Blocked { reason: LoadState },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyNormalChoice {
    QueueFile,
    CatalogNormal,
}

impl Default for PlaybackState {
    fn default() -> Self {
        Self {
            schema_version: PLAYBACK_STATE_SCHEMA_VERSION,
            revision: 0,
            queue: Vec::new(),
            session: Session::new(),
            catalog: Catalog::default(),
            settings: Settings::default(),
        }
    }
}

impl PlaybackState {
    fn validate(&self) -> Result<(), PlaylistError> {
        if self.schema_version != PLAYBACK_STATE_SCHEMA_VERSION {
            return Err(PlaylistError::StoreReadOnly {
                state: LoadState::UnsupportedSchema,
            });
        }
        self.catalog.validate()?;
        if self.catalog.current.as_ref().is_some_and(|current| {
            current.origin == crate::playlists::PlaybackOrigin::Normal
                && current.queue_item.is_none()
        }) {
            return Err(PlaylistError::PersistFailed {
                message: "normal current occurrence is missing its durable queue identity".into(),
            });
        }
        validate_occurrences(&self.queue, &self.session.in_flight)
            .map_err(|message| PlaylistError::PersistFailed { message })?;
        if let Some(normal) = &self.catalog.normal {
            validate_occurrences(&normal.items, &self.queue)
                .map_err(|message| PlaylistError::PersistFailed { message })?;
            validate_occurrences(&normal.items, &self.session.in_flight)
                .map_err(|message| PlaylistError::PersistFailed { message })?;
        }
        if let Some(current) = self.catalog.current.as_ref()
            .filter(|current| current.origin == crate::playlists::PlaybackOrigin::Normal)
        {
            let item = current.queue_item.as_ref().unwrap();
            let conflict = item.entry_id.trim().is_empty()
                || item.path != current.track_ref.preferred_path
                || current.queue_origin.is_some_and(|origin| origin != item.origin)
                || self.queue.iter().chain(self.session.in_flight.iter())
                    .chain(self.catalog.normal.iter().flat_map(|normal| normal.items.iter()))
                    .any(|other| {
                    other.entry_id == item.entry_id
                        && (other.path != item.path || other.origin != item.origin)
                });
            if conflict {
                return Err(PlaylistError::PersistFailed {
                    message: "normal current occurrence conflicts with saved identity".into(),
                });
            }
        }
        Ok(())
    }
}

fn validate_occurrences(queue: &[QueueItem], in_flight: &[QueueItem]) -> Result<(), String> {
    let mut seen = HashMap::new();
    for item in queue {
        if item.entry_id.trim().is_empty() { return Err("blank queue occurrence id".into()); }
        if seen.insert(item.entry_id.clone(), item).is_some() {
            return Err("duplicate queue occurrence id".into());
        }
    }
    let mut session_ids = HashMap::new();
    for item in in_flight {
        if item.entry_id.trim().is_empty() { return Err("blank session occurrence id".into()); }
        if session_ids.insert(item.entry_id.clone(), item).is_some() {
            return Err("duplicate session occurrence id".into());
        }
        if let Some(queue_item) = seen.get(&item.entry_id) {
            if queue_item.path != item.path || queue_item.origin != item.origin {
                return Err("queue/session occurrence id conflicts".into());
            }
        }
    }
    Ok(())
}

#[derive(Clone)]
pub struct PlaybackStore {
    dir: PathBuf,
    state: Arc<Mutex<StoreState>>,
    _lock: Arc<Option<File>>,
}

enum StoreState {
    Ready {
        snapshot: PlaybackState,
        bytes: Option<Vec<u8>>,
        load_state: LoadState,
    },
    LegacyNormalConflict(LegacyNormalConflict),
    ReadOnly(LoadState),
}

#[derive(Clone)]
struct LegacySources {
    queue: Option<Vec<u8>>,
    session: Option<Vec<u8>>,
    catalog: Option<Vec<u8>>,
    settings: Option<Vec<u8>>,
}

impl LegacySources {
    fn read(dir: &Path) -> Result<Self, LoadState> {
        Ok(Self {
            queue: read_bytes(dir, "queue.json").map_err(|_| LoadState::IoError)?,
            session: read_bytes(dir, "session.json").map_err(|_| LoadState::IoError)?,
            catalog: read_bytes(dir, "playlists.json").map_err(|_| LoadState::IoError)?,
            settings: read_bytes(dir, "settings.json").map_err(|_| LoadState::IoError)?,
        })
    }

    fn matches(&self, dir: &Path) -> Result<bool, LoadState> {
        Ok(read_bytes(dir, FILE_NAME).map_err(|_| LoadState::IoError)?.is_none()
            && read_bytes(dir, "queue.json").map_err(|_| LoadState::IoError)? == self.queue
            && read_bytes(dir, "session.json").map_err(|_| LoadState::IoError)? == self.session
            && read_bytes(dir, "playlists.json").map_err(|_| LoadState::IoError)? == self.catalog
            && read_bytes(dir, "settings.json").map_err(|_| LoadState::IoError)? == self.settings)
    }
}

struct LegacyNormalConflict {
    token: u64,
    queue_snapshot: PlaybackState,
    catalog_snapshot: PlaybackState,
    sources: LegacySources,
}

enum ReadSnapshot {
    Snapshot { load_state: LoadState, snapshot: PlaybackState, bytes: Option<Vec<u8>> },
    LegacyNormalConflict(LegacyNormalConflict),
}

static STORES: LazyLock<Mutex<HashMap<PathBuf, Weak<PlaybackStore>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_RECOVERY_TOKEN: AtomicU64 = AtomicU64::new(1);

impl PlaybackStore {
    pub fn open(dir: impl Into<PathBuf>) -> Arc<Self> {
        let dir = dir.into();
        let mut stores = STORES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(store) = stores.get(&dir).and_then(Weak::upgrade) {
            return store;
        }
        let (lock, state) = match acquire_lock(&dir) {
            Ok(lock) => match read_snapshot_or_legacy(&dir) {
                Ok(ReadSnapshot::Snapshot { load_state: LoadState::Missing, snapshot, .. }) => {
                    let bytes = serde_json::to_vec_pretty(&snapshot)
                        .map_err(io::Error::other)
                        .and_then(|bytes| persist_snapshot(&dir, &bytes).map(|()| bytes));
                    match bytes {
                        Ok(bytes) => (
                            Some(lock),
                            StoreState::Ready {
                                snapshot,
                                bytes: Some(bytes),
                                load_state: LoadState::Ready,
                            },
                        ),
                        Err(_) => (Some(lock), StoreState::ReadOnly(LoadState::IoError)),
                    }
                },
                Ok(ReadSnapshot::Snapshot { load_state, snapshot, bytes }) => (
                    Some(lock),
                    StoreState::Ready {
                        snapshot,
                        bytes,
                        load_state,
                    },
                ),
                Ok(ReadSnapshot::LegacyNormalConflict(conflict)) => (
                    Some(lock),
                    StoreState::LegacyNormalConflict(conflict),
                ),
                Err(state) => (Some(lock), StoreState::ReadOnly(state)),
            },
            Err(error) => (
                None,
                StoreState::ReadOnly(if error.kind() == io::ErrorKind::WouldBlock {
                    LoadState::Busy
                } else {
                    LoadState::IoError
                }),
            ),
        };
        let store = Arc::new(Self {
            dir: dir.clone(),
            state: Arc::new(Mutex::new(state)),
            _lock: Arc::new(lock),
        });
        stores.insert(dir, Arc::downgrade(&store));
        store
    }

    pub fn load_state(&self) -> LoadState {
        let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if snapshot_bytes_changed(&self.dir, &state) {
            return LoadState::Stale;
        }
        match &*state {
            StoreState::Ready { load_state, .. } => load_state.clone(),
            StoreState::LegacyNormalConflict(_) => LoadState::LegacyNormalConflict,
            StoreState::ReadOnly(state) => state.clone(),
        }
    }

    pub fn recovery_status(&self) -> PlaybackRecoveryStatus {
        let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if snapshot_bytes_changed(&self.dir, &state) {
            return PlaybackRecoveryStatus::Blocked { reason: LoadState::Stale };
        }
        match &*state {
            StoreState::Ready { .. } => PlaybackRecoveryStatus::Ready,
            StoreState::LegacyNormalConflict(conflict) => PlaybackRecoveryStatus::LegacyNormalConflict {
                token: conflict.token,
                queue_file_items: conflict.queue_snapshot.queue.len(),
                catalog_normal_items: conflict.catalog_snapshot.queue.len(),
            },
            StoreState::ReadOnly(reason) => PlaybackRecoveryStatus::Blocked { reason: reason.clone() },
        }
    }

    pub fn snapshot(&self) -> Result<PlaybackState, PlaylistError> {
        let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if snapshot_bytes_changed(&self.dir, &state) {
            return Err(PlaylistError::Stale);
        }
        match &*state {
            StoreState::Ready { snapshot, .. } => Ok(snapshot.clone()),
            StoreState::LegacyNormalConflict(_) => Err(PlaylistError::StoreReadOnly {
                state: LoadState::LegacyNormalConflict,
            }),
            StoreState::ReadOnly(state) => Err(PlaylistError::StoreReadOnly {
                state: state.clone(),
            }),
        }
    }

    pub fn settings_snapshot(&self) -> Result<Settings, PlaylistError> {
        let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match &*state {
            StoreState::Ready { snapshot, .. } => {
                if snapshot_bytes_changed(&self.dir, &state) {
                    Err(PlaylistError::Stale)
                } else {
                    Ok(snapshot.settings.clone())
                }
            }
            StoreState::LegacyNormalConflict(conflict) => match conflict.sources.matches(&self.dir) {
                Ok(true) => Ok(conflict.queue_snapshot.settings.clone()),
                Ok(false) => Err(PlaylistError::Stale),
                Err(state) => Err(PlaylistError::StoreReadOnly { state }),
            },
            StoreState::ReadOnly(state) => Err(PlaylistError::StoreReadOnly {
                state: state.clone(),
            }),
        }
    }

    pub fn reload(&self) -> Result<PlaybackState, PlaylistError> {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if self._lock.is_none() {
            return Err(read_only(&state));
        }
        match read_snapshot_or_legacy(&self.dir).map_err(|state| PlaylistError::StoreReadOnly { state })? {
            ReadSnapshot::Snapshot { load_state, snapshot, bytes } => {
                *state = StoreState::Ready { snapshot: snapshot.clone(), bytes, load_state };
                Ok(snapshot)
            }
            ReadSnapshot::LegacyNormalConflict(conflict) => {
                *state = StoreState::LegacyNormalConflict(conflict);
                Err(PlaylistError::StoreReadOnly { state: LoadState::LegacyNormalConflict })
            }
        }
    }

    pub fn update<R>(
        &self,
        mutate: impl FnOnce(&mut PlaybackState) -> Result<R, PlaylistError>,
    ) -> Result<R, PlaylistError> {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let StoreState::Ready {
            snapshot,
            bytes,
            ..
        } = &*state
        else {
            return Err(read_only(&state));
        };
        let observed = read_bytes(&self.dir, FILE_NAME)
            .map_err(|_| PlaylistError::StoreReadOnly { state: LoadState::IoError })?;
        if &observed != bytes {
            return Err(PlaylistError::Stale);
        }
        let mut candidate = snapshot.clone();
        let value = mutate(&mut candidate)?;
        candidate.revision = candidate
            .revision
            .checked_add(1)
            .ok_or_else(|| PlaylistError::PersistFailed {
                message: "playback state revision exhausted".into(),
            })?;
        candidate.validate()?;
        let encoded = serde_json::to_vec_pretty(&candidate).map_err(|error| {
            PlaylistError::PersistFailed {
                message: error.to_string(),
            }
        })?;
        persist_snapshot(&self.dir, &encoded).map_err(|error| PlaylistError::PersistFailed {
            message: error.to_string(),
        })?;
        *state = StoreState::Ready {
            snapshot: candidate,
            bytes: Some(encoded),
            load_state: LoadState::Ready,
        };
        Ok(value)
    }

    pub(crate) fn resolve_legacy_normal_conflict<R>(
        &self,
        token: u64,
        choice: LegacyNormalChoice,
        prepare: impl FnOnce(&mut PlaybackState) -> Result<R, PlaylistError>,
    ) -> Result<R, PlaylistError> {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if self._lock.is_none() {
            return Err(read_only(&state));
        }
        let conflict = match &*state {
            StoreState::LegacyNormalConflict(conflict) => conflict,
            StoreState::ReadOnly(_) => return Err(read_only(&state)),
            StoreState::Ready { .. } => return Err(PlaylistError::Stale),
        };
        if conflict.token != token {
            return Err(PlaylistError::Stale);
        }
        match conflict.sources.matches(&self.dir) {
            Ok(true) => {}
            Ok(false) => return Err(PlaylistError::Stale),
            Err(state) => return Err(PlaylistError::StoreReadOnly { state }),
        }
        let mut snapshot = match choice {
            LegacyNormalChoice::QueueFile => conflict.queue_snapshot.clone(),
            LegacyNormalChoice::CatalogNormal => conflict.catalog_snapshot.clone(),
        };
        let value = prepare(&mut snapshot)?;
        snapshot.validate()?;
        let encoded = serde_json::to_vec_pretty(&snapshot).map_err(|error| PlaylistError::PersistFailed {
            message: error.to_string(),
        })?;
        persist_snapshot(&self.dir, &encoded).map_err(|error| PlaylistError::PersistFailed {
            message: error.to_string(),
        })?;
        *state = StoreState::Ready {
            snapshot,
            bytes: Some(encoded),
            load_state: LoadState::Ready,
        };
        Ok(value)
    }
}

fn read_snapshot_or_legacy(
    dir: &Path,
) -> Result<ReadSnapshot, LoadState> {
    let Some(bytes) = read_bytes(dir, FILE_NAME).map_err(|_| LoadState::IoError)? else {
        let sources = LegacySources::read(dir)?;
        let saved_queue = crate::store::load_legacy_queue_strict(dir)?;
        let queue_exists = saved_queue.is_some();
        let queue = saved_queue.unwrap_or_default();
        let session = crate::store::load_legacy_session_strict(dir)?;
        let settings = crate::store::load_legacy_settings_strict(dir)?;
        let catalog = crate::playlists::load_legacy_catalog_strict(dir)?;
        let mut snapshot = PlaybackState {
            queue,
            session,
            catalog,
            settings,
            ..PlaybackState::default()
        };
        if queue_exists && snapshot.catalog.normal.as_ref().is_some_and(|normal| snapshot.queue != normal.items) {
            let queue_snapshot = legacy_normal_candidate(&snapshot, snapshot.queue.clone())?;
            let catalog_items = snapshot.catalog.normal.as_ref().unwrap().items.clone();
            let catalog_snapshot = legacy_normal_candidate(&snapshot, catalog_items)?;
            return Ok(ReadSnapshot::LegacyNormalConflict(LegacyNormalConflict {
                token: next_recovery_token()?, queue_snapshot, catalog_snapshot, sources,
            }));
        }
        import_legacy_normal_source(&mut snapshot, queue_exists)?;
        restore_legacy_normal_current_identity(&mut snapshot);
        snapshot.validate().map_err(|_| LoadState::Corrupt)?;
        return Ok(ReadSnapshot::Snapshot { load_state: LoadState::Missing, snapshot, bytes: None });
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| LoadState::Corrupt)?;
    match value.get("schema_version").and_then(serde_json::Value::as_u64) {
        Some(version) if version == u64::from(PLAYBACK_STATE_SCHEMA_VERSION) => {}
        Some(_) => return Err(LoadState::UnsupportedSchema),
        None => return Err(LoadState::Corrupt),
    }
    require_saved_occurrence_ids(&value)?;
    let snapshot: PlaybackState = serde_json::from_value(value).map_err(|_| LoadState::Corrupt)?;
    snapshot.validate().map_err(|error| match error {
        PlaylistError::StoreReadOnly { state } => state,
        _ => LoadState::Corrupt,
    })?;
    Ok(ReadSnapshot::Snapshot { load_state: LoadState::Ready, snapshot, bytes: Some(bytes) })
}

fn next_recovery_token() -> Result<u64, LoadState> {
    NEXT_RECOVERY_TOKEN.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |token| {
        token.checked_add(1)
    }).map_err(|_| LoadState::IoError)
}

fn legacy_normal_candidate(snapshot: &PlaybackState, items: Vec<QueueItem>) -> Result<PlaybackState, LoadState> {
    let mut candidate = snapshot.clone();
    candidate.queue = items.clone();
    candidate.catalog.normal.as_mut().expect("legacy conflict has normal queue").items = items;
    restore_legacy_normal_current_identity(&mut candidate);
    candidate.validate().map_err(|_| LoadState::Corrupt)?;
    Ok(candidate)
}

fn require_saved_occurrence_ids(value: &serde_json::Value) -> Result<(), LoadState> {
    let valid = |item: &serde_json::Value| item.get("entry_id")
        .and_then(serde_json::Value::as_str).is_some_and(|id| !id.trim().is_empty());
    for location in ["/queue", "/session/in_flight", "/catalog/normal/items"] {
        if let Some(items) = value.pointer(location) {
            if !items.as_array().is_some_and(|items| items.iter().all(&valid)) {
                return Err(LoadState::Corrupt);
            }
        }
    }
    if let Some(item) = value.pointer("/catalog/current/queue_item").filter(|item| !item.is_null()) {
        if !valid(item) { return Err(LoadState::Corrupt); }
    }
    Ok(())
}

fn import_legacy_normal_source(snapshot: &mut PlaybackState, queue_exists: bool) -> Result<(), LoadState> {
    if let Some(normal) = &snapshot.catalog.normal {
        // A catalog-only deletion and an interrupted queue-only automatic add
        // can leave identical legacy files. Neither copy establishes ordering.
        if queue_exists && snapshot.queue != normal.items {
            return Err(LoadState::Stale);
        }
        snapshot.queue = normal.items.clone();
    }
    Ok(())
}

fn restore_legacy_normal_current_identity(snapshot: &mut PlaybackState) {
    let Some(current) = snapshot.catalog.current.as_ref().filter(|current| {
        current.origin == crate::playlists::PlaybackOrigin::Normal
            && current.queue_item.is_none()
    }) else {
        return;
    };
    let matching_item = snapshot.session.in_flight.first().filter(|item| {
        item.path == current.track_ref.preferred_path
            && Some(item.origin) == current.queue_origin
    })
        .cloned();
    let new_item = matching_item.is_none().then(|| {
        QueueItem::with_origin(
            current.track_ref.preferred_path.clone(),
            current.queue_origin.unwrap_or(crate::queue::QueueOrigin::Manual),
        )
    });
    if let Some(current) = snapshot.catalog.current.as_mut() {
        current.queue_item = matching_item.or_else(|| new_item.clone());
    }
    if let Some(item) = new_item {
        snapshot.session.in_flight.insert(0, item);
    }
}

fn snapshot_bytes_changed(dir: &Path, state: &StoreState) -> bool {
    let StoreState::Ready { bytes, .. } = state else {
        return false;
    };
    match read_bytes(dir, FILE_NAME) {
        Ok(observed) => &observed != bytes,
        Err(_) => true,
    }
}

fn read_bytes(dir: &Path, file: &str) -> io::Result<Option<Vec<u8>>> {
    match fs::read(dir.join(file)) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn persist_snapshot(dir: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(test)]
    park_at_crash_stage(0);
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    #[cfg(test)]
    {
        fail_persist_stage(1)?;
        park_at_crash_stage(1);
    }
    tmp.write_all(bytes)?;
    #[cfg(test)]
    {
        fail_persist_stage(2)?;
        park_at_crash_stage(2);
    }
    tmp.as_file().sync_all()?;
    #[cfg(test)]
    {
        fail_persist_stage(3)?;
        park_at_crash_stage(3);
    }
    tmp.persist(dir.join(FILE_NAME)).map_err(|error| error.error)?;
    #[cfg(test)]
    park_at_crash_stage(4);
    Ok(())
}

fn acquire_lock(dir: &Path) -> io::Result<File> {
    fs::create_dir_all(dir)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(dir.join(LOCK_NAME))?;
    #[cfg(target_os = "android")]
    {
        let result = unsafe {
            libc::flock(
                std::os::fd::AsRawFd::as_raw_fd(&file),
                libc::LOCK_EX | libc::LOCK_NB,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    #[cfg(not(target_os = "android"))]
    file.try_lock()?;
    Ok(file)
}

fn read_only(state: &StoreState) -> PlaylistError {
    match state {
        StoreState::LegacyNormalConflict(_) => PlaylistError::StoreReadOnly {
            state: LoadState::LegacyNormalConflict,
        },
        StoreState::ReadOnly(state) => PlaylistError::StoreReadOnly {
            state: state.clone(),
        },
        StoreState::Ready { .. } => unreachable!(),
    }
}


#[cfg(test)]
#[path = "playback_state_fault_tests.rs"]
mod fault_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn item(path: &str) -> QueueItem {
        QueueItem::manual(PathBuf::from(path))
    }

    #[test]
    fn imports_one_legacy_generation_once_and_preserves_duplicate_paths() {
        let dir = tempfile::tempdir().unwrap();
        let first = item("/music/repeated.flac");
        let second = item("/music/repeated.flac");
        assert_ne!(first.entry_id, second.entry_id);
        let queue_bytes = serde_json::to_vec_pretty(&vec![first.clone(), second.clone()]).unwrap();
        fs::write(dir.path().join("queue.json"), &queue_bytes).unwrap();
        let session = Session { in_flight: vec![first.clone()], paused: true };
        fs::write(dir.path().join("session.json"), serde_json::to_vec_pretty(&session).unwrap()).unwrap();
        let settings = Settings { locale: Some("ja".into()), ..Settings::default() };
        fs::write(dir.path().join("settings.json"), serde_json::to_vec_pretty(&settings).unwrap()).unwrap();

        let store = PlaybackStore::open(dir.path());
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.queue, vec![first.clone(), second.clone()]);
        assert_eq!(snapshot.session, session);
        assert_eq!(snapshot.settings, settings);
        assert_eq!(fs::read(dir.path().join("queue.json")).unwrap(), queue_bytes);
        assert!(dir.path().join(FILE_NAME).is_file());
        drop(store);

        let reopened = PlaybackStore::open(dir.path());
        let restored = crate::store::restored_pending(
            &reopened.snapshot().unwrap().session.in_flight,
            &reopened.snapshot().unwrap().queue,
        );
        assert_eq!(restored, vec![first, second]);
    }

    #[test]
    fn legacy_normal_current_adopts_only_a_matching_session_occurrence() {
        let dir = tempfile::tempdir().unwrap();
        let current = QueueItem::automatic(PathBuf::from("/music/current.flac"));
        let session = Session {
            in_flight: vec![current.clone()],
            paused: false,
        };
        fs::write(
            dir.path().join("session.json"),
            serde_json::to_vec_pretty(&session).unwrap(),
        )
        .unwrap();
        let mut catalog = Catalog::default();
        catalog.current = Some(crate::playlists::CurrentOccurrence {
            playlist_id: None,
            run_id: 0,
            entry_id: None,
            track_ref: crate::playlists::TrackRef {
                content_hash: String::new(),
                preferred_path: current.path.clone(),
                title: String::new(),
                artist: String::new(),
            },
            origin: crate::playlists::PlaybackOrigin::Normal,
            queue_origin: Some(current.origin),
            queue_item: None,
        });
        fs::write(
            dir.path().join("playlists.json"),
            serde_json::to_vec_pretty(&catalog).unwrap(),
        )
        .unwrap();

        let snapshot = PlaybackStore::open(dir.path()).snapshot().unwrap();
        assert_eq!(
            snapshot.catalog.current.unwrap().queue_item,
            Some(current.clone())
        );
        assert_eq!(snapshot.session.in_flight, vec![current]);
    }

    #[test]
    fn legacy_normal_current_without_a_session_match_gets_one_persisted_identity() {
        let dir = tempfile::tempdir().unwrap();
        let unrelated = QueueItem::manual(PathBuf::from("/music/other.flac"));
        fs::write(
            dir.path().join("session.json"),
            serde_json::to_vec_pretty(&Session {
                in_flight: vec![unrelated.clone()],
                paused: false,
            })
            .unwrap(),
        )
        .unwrap();
        let mut catalog = Catalog::default();
        catalog.current = Some(crate::playlists::CurrentOccurrence {
            playlist_id: None,
            run_id: 0,
            entry_id: None,
            track_ref: crate::playlists::TrackRef {
                content_hash: String::new(),
                preferred_path: PathBuf::from("/music/current.flac"),
                title: String::new(),
                artist: String::new(),
            },
            origin: crate::playlists::PlaybackOrigin::Normal,
            queue_origin: Some(crate::queue::QueueOrigin::Manual),
            queue_item: None,
        });
        fs::write(
            dir.path().join("playlists.json"),
            serde_json::to_vec_pretty(&catalog).unwrap(),
        )
        .unwrap();

        let store = PlaybackStore::open(dir.path());
        let snapshot = store.snapshot().unwrap();
        let current = snapshot.catalog.current.unwrap().queue_item.unwrap();
        assert_ne!(current.entry_id, unrelated.entry_id);
        assert_eq!(snapshot.session.in_flight[0], current);
        drop(store);
        assert_eq!(
            PlaybackStore::open(dir.path())
                .snapshot()
                .unwrap()
                .catalog
                .current
                .unwrap()
                .queue_item
                .unwrap()
                .entry_id,
            current.entry_id
        );
    }

    #[test]
    fn migrated_legacy_queue_is_imported_before_snapshot_creation() {
        let old = tempfile::tempdir().unwrap();
        let new = tempfile::tempdir().unwrap();
        let queued = item("/music/rescued.flac");
        fs::write(
            old.path().join("queue.json"),
            serde_json::to_vec_pretty(&vec![queued.clone()]).unwrap(),
        ).unwrap();
        crate::store::migrate_from(old.path(), new.path());
        assert!(!old.path().join("queue.json").exists());
        let snapshot = PlaybackStore::open(new.path()).snapshot().unwrap();
        assert_eq!(snapshot.queue, vec![queued]);
    }

    #[test]
    fn corrupt_legacy_bytes_block_writes_without_creating_a_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let corrupt = b"[";
        fs::write(dir.path().join("queue.json"), corrupt).unwrap();
        let store = PlaybackStore::open(dir.path());
        assert_eq!(store.load_state(), LoadState::Corrupt);
        assert!(store.snapshot().is_err());
        assert!(crate::store::save_queue(
            dir.path(),
            &VecDeque::from([item("/music/new.flac")]),
        ).is_err());
        assert_eq!(fs::read(dir.path().join("queue.json")).unwrap(), corrupt);
        assert!(!dir.path().join(FILE_NAME).exists());
    }

    #[test]
    fn failed_snapshot_write_keeps_all_components_at_the_previous_revision() {
        let dir = tempfile::tempdir().unwrap();
        let store = PlaybackStore::open(dir.path());
        let before = store.snapshot().unwrap();
        let before_bytes = fs::read(dir.path().join(FILE_NAME)).unwrap();
        set_fail_persist_stage(2);
        assert!(store.update(|state| {
            state.queue = vec![item("/music/new.flac")];
            state.session.paused = true;
            state.settings.locale = Some("id".into());
            Ok(())
        }).is_err());
        assert_eq!(store.snapshot().unwrap(), before);
        assert_eq!(fs::read(dir.path().join(FILE_NAME)).unwrap(), before_bytes);
    }
}
