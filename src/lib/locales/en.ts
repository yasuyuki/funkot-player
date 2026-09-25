// Canonical message catalogue. `Messages` is derived from this object, so
// every other locale is checked against it by `npm run check`: a missing key,
// a stray key, or a function whose parameters drifted all fail to compile.
//
// Interpolated messages are *functions*, not templates with placeholders.
// Word order moves between the three languages ("Found 3 tracks" /
// "3曲見つかりました" / "3 lagu ditemukan"), and a function lets each locale
// put the pieces where its own grammar wants them -- including the plural
// suffix English needs and Indonesian does not.

export const en = {
  // --- App shell / navigation ---
  playTabsLabel: "Playback tabs",
  editTabsLabel: "Edit tabs",
  queueHeading: "Up next",
  libraryHeading: "Library",
  tabFlags: "Transitions to fix",
  tabAllTracks: "All tracks",

  // --- Transport ---
  start: "Start",
  pause: "⏸ Pause",
  resumePlayback: "▶ Resume",
  nextTrack: "⏭ Next track",
  playbackControlsLabel: "Playback controls",
  resumeLabel: "Resume",
  pauseLabel: "Pause",
  nextTrackLabel: "Next track",

  // --- Now playing ---
  phaseIdle: "Idle",
  phaseStarting: "Starting",
  phasePlaying: "Playing",
  phasePaused: "Paused",
  phaseStalled: "Preparing next track",
  phaseFailed: "Cannot play",
  phaseDisconnected: "Reconnecting output",

  // --- Audition ---
  auditioning: (from: string, to: string) => `Auditioning “${from}” → “${to}”`,
  autoplayInterrupted: "Auto-play interrupted",
  resumeAction: "〔Resume〕",
  auditioningShort: "Auditioning",

  // --- Labels ---
  funkot: "Funkot",
  notFunkot: "Non-Funkot",
  noLabel: "—",
  labeledFunkot: "Labeled Funkot",
  labeledNotFunkot: "Labeled non-Funkot",
  labelMenuLabel: "Track label",
  bulkLabeled: (n: number, verdict: boolean) =>
    `Labeled ${n} ${n === 1 ? "track" : "tracks"} as ${verdict ? "Funkot" : "non-Funkot"}`,

  // --- Toast / boundary ---
  undo: "Undo",
  retry: "Retry",
  changed: "Changed",
  deleted: "Deleted",

  // --- New arrivals ---
  queueNewArrivals: (count: number) =>
    `Put ${count} new ${count === 1 ? "track" : "tracks"} at the front of the queue`,

  // --- Log panel ---
  logTitle: "Log",
  close: "Close",
  musicFolderLabel: "Music folder",
  cacheLabel: "Cache",
  arrivalsInspect: (listed: number, gated: number, banner: number) =>
    `New: listed ${listed} / after gate ${gated} / banner ${banner}`,
  historyRevLine: (rev: string, applied: string) => `history rev ${rev} / applied ${applied}`,
  arrivalsPathsLabel: "New paths",
  showLog: "Show log",

  // --- Transition strip ---
  lastAutoTransition: "Last automatic transition",
  secondsAgo: (s: number) => `${s}s ago`,
  minutesAgo: (m: number) => `${m}m ago`,
  noTransitionYet: "No transitions yet",
  flagBadTransition: "⚑ This transition is wrong",
  flagRecorded: (from: string, to: string) => `Recorded ${from} → ${to}`,
  toEditModeLabel: "Go to edit mode",
  toPlayModeLabel: "Go to playback mode",
  editMode: "Edit",
  playMode: "Play",

  // --- Queue ---
  queueEmpty: "Queue is empty — auto-select keeps going",
  queuePreparing: "Preparing",
  queuePrepared: "Ready",
  automaticSelection: "Automatic selection",
  transitionIn: (clock: string) => `Switch in ${clock}`,
  moveUpLabel: "Move up",
  moveDownLabel: "Move down",
  removeLabel: "Remove",
  queueErrTooLate: "Too late to change this one",
  queueErrStale: "The queue changed",
  queueErrAuditioning: "Cannot edit while auditioning",
  queueErrOriginBoundary: "Manual and automatic tracks cannot be reordered across each other",
  queueErrGeneric: "Could not update the queue",
  playlistNormal: "Queue",
  playlistLoading: "Loading playlist…",
  playlistTrackCount: (count: number) => `${count} ${count === 1 ? "track" : "tracks"}`,
  playlistDestination: (name: string) => `Adding to: ${name}`,
  playlistAddLabel: (title: string, destination: string) => `Add ${title} to ${destination}`,
  playlistAddResult: (summary: string, destination: string) => `To ${destination}: ${summary}`,
  playlistChoose: "Choose what plays next",
  playlistSearch: "Search playlists",
  playlistNewName: "New playlist name",
  playlistCreateUse: "Create and use",
  playlistCount: (remaining: number, total: number) => `${remaining} remaining / ${total} total`,
  playlistMenu: "Playlist actions",
  playlistEditAll: "Show and edit all tracks",
  playlistShowRemaining: "Show remaining tracks",
  playlistRestart: "Start over (current song keeps playing)",
  playlistEnded: "Playback ended",
  playlistEmpty: "No tracks in this playlist",
  playlistRemoveLabel: (title: string) => `Remove ${title} from this playlist`,
  playlistRemoved: "Removed from playlist",
  playlistError: (code: string) => ({ stale: "This list changed. Refreshed it for review.", invalid_input: "Check the playlist name.", not_found: "That playlist no longer exists.", active_list: "Choose another source before deleting this playlist.", store_read_only: "Playlists are read-only.", persist_failed: "Could not save the playlist.", busy: "Playlist editing is busy.", transition_in_progress: "Cannot switch while tracks are changing.", transition_paused: "The track change is paused. Resume playback, then try again after the change finishes.", active_upgrade_pending: "Wait for the current track to finish preparing, then try again.", navigation_pending: "Wait for the next track change, then try again.", no_runway: "Too close to the next track to change the list. Try again after it starts.", auditioning: "Cannot change playlists while auditioning.", identity_unavailable: "This track cannot be identified for a playlist.", identity_changed: "The track changed on disk. Refresh the library and try again.", duplicate_undo: "This removal was already undone." })[code] ?? "Could not update the playlist.",
  playlistBrowse: "Browse all tracks",
  playlistBrowseLabel: (name: string) => `Browse ${name}`,
  playlistRename: "Rename",
  playlistDuplicate: "Duplicate",
  playlistDelete: "Delete",
  playlistSaveQueue: "Save queue as playlist",
  playlistSaveQueueScope: "Copies the upcoming tracks shown here, including prepared and automatic picks. The current song is excluded; the queue and playback source stay as they are.",
  playlistSave: "Save",
  playlistConfirmName: (name: string) => `Type “${name}” to delete this playlist`,
  playlistReadOnly: "Playlists are read-only because saved data could not be loaded. Queue playback remains available.",
  playlistSaveFailedRetry: "The latest playlist change could not be saved. Check storage and try again.",
  playlistSkipped: (count: number) => `${count} skipped`,
  playlistStatus: (status: string) => ({ pending: "Next", preparing: "Preparing", prepared: "Ready", missing: "Missing", unplayable: "Cannot play", played: "Played", current: "Playing" })[status] ?? status,
  playlistFailureReason: (reason: string) => ({ missing: "The file is missing.", non_funkot: "Excluded by the Funkot-only setting.", identity_changed: "The file changed since it was added.", identity_unavailable: "This track could not be identified.", load_failed: "The track could not be loaded.", loader_failure: "The track could not be loaded." })[reason] ?? "The track could not be loaded.",
  playlistCreateSavedSelectionFailed: (name: string, reason: string) => `Created “${name}”, but could not switch to it: ${reason}`,

  // --- Library ---
  searchPlaceholder: "Search",
  searchLabel: "Search the library",
  newOnly: "New only",
  sortRecent: "Newest▾",
  sortTitle: "Title▾",
  sortArtist: "Artist▾",
  scanningWalking: "Scanning…",
  scanningHashing: (found: number, done: number) =>
    `Scanning — checking ${found} tracks, ${done}/${found}`,
  analyzing: (done: number, total: number, name: string) =>
    `Analyzing ${done}/${total}: ${name}`,
  noTracks: "No tracks",
  addToQueueLabel: (title: string) => `Add ${title} to the queue`,
  tagEditorTitle: (title: string) => `Edit tags: ${title}`,
  tagEditorScope: (count: number) =>
    count === 1 ? "This track" : `${count} displayed selected tracks`,
  tagEdit: "Edit tags",
  tagEditSelected: "Edit tags",
  tagEditCount: (count: number) => `Edit visible selected (${count})`,
  tagEnqueueCount: (count: number) => `Add to queue (${count})`,
  tagIdentityUnavailable:
    "A resolved content identity is needed before tags can be edited.",
  tagYear: "Production year",
  tagNoChange: "Do not change",
  tagYearAuto: "Use automatic year",
  tagYearUnset: "Keep year unset",
  tagYearSet: "Set year",
  tagKind: "Kind",
  tagGenre: "Genre",
  tagCustom: "Custom",
  tagValue: "Tag",
  tagAdd: "Add tag",
  tagSave: "Save",
  tagSaving: "Saving…",
  tagReload: "Reload tags",
  tagError: (code: string) =>
    ({
      stale_revision:
        "Tags changed elsewhere. Reload and review the same targets.",
      store_read_only: "The tag store is read-only.",
      busy: "Tag editing is busy.",
      identity_changed: "A selected track changed.",
      identity_unavailable: "This track is not ready for tag editing.",
      persist_failed: "Could not save tags.",
      invalid_input: "Check the tag value.",
    })[code] ?? "Could not save tags",
  tagSaved: (count: number) =>
    count === 1 ? "Tag saved" : `Tags saved for ${count} tracks`,
  tagNoop: "No tag changes",
  tagFileUntouched:
    "Tags classify tracks in this player. Audio files are not changed.",
  tagSharedIdentity: (count: number) => `Copies of the same audio share tags; ${count} distinct tracks will be updated.`,
  tagSnapshotChanged: "Tags changed elsewhere",
  tagReloading: "Reloading tags…",
  tagReloaded: "Tags reloaded",
  tagEffectiveYear: "Effective year",
  tagMixed: "Mixed",
  tagUnset: "Unset",
  tagEmpty: "None",
  tagManualMode: (mode: string) =>
    `Year mode: ${{ auto: "automatic", set: "set", unset: "unset" }[mode] ?? "automatic"}`,
  tagOrigin: (origin: string) =>
    `Source: ${{ embedded: "embedded metadata", manual: "manual", both: "both" }[origin] ?? "unknown"}`,
  tagMetadataStatus: (status: string) =>
    ({
      pending: "Metadata pending",
      ready: "Metadata ready",
      error: "Metadata error",
    })[status] ?? "Metadata unavailable",
  tagYearStatus: (status: string) =>
    ({
      resolved: "Year resolved",
      missing: "Year missing",
      invalid: "Year invalid",
      future: "Future year",
      conflict: "Conflicting years",
    })[status] ?? "Year unavailable",
  tagSemantic: (semantic: string) =>
    ({
      recording: "Recording",
      generic: "Date/year",
      release: "Release",
      original: "Original release",
    })[semantic] ?? "Other",
  tagYearCandidates: "Year candidates",
  tagAdoptYear: (year: number) => `Use ${year}`,
  tagCurrentTags: "Current tags",
  tagPresent: (count: number, total: number) =>
    count === total
      ? `Common to all ${total}`
      : `Present in ${count} of ${total} / mixed`,
  tagRemoveScope:
    "Removal applies to every selected track and suppresses a matching automatic tag after a scan.",
  tagSuppressed: "Suppressed",
  tagRestore: "Restore",
  tagPendingAdds: "Pending additions",
  tagPendingRemovals: "Pending removals",
  tagUndo: "Undo",
  tagRemove: (value: string) => `Remove ${value}`,
  tagLimits:
    "128 Unicode characters per value; 128 effective genre/custom tags.",
  tagDiagnostics: "Metadata details",
  tagFilterToggle: "Tags",
  tagFilterTitle: "Filter by tags",
  tagFilterCandidate: "Tag candidate",
  tagFilterPick: "Choose a tag",
  tagFilterAdd: "Add condition",
  tagCandidatePopulation: "Candidates and counts cover the whole current library, before filtering.",
  tagCandidateCount: (count: number) => `${count} tracks`,
  tagFilterMode: "Match selected tags",
  tagMatchAll: "AND — all selected tags",
  tagMatchAny: "OR — any selected tag",
  tagFilterUnset: "Production year unset",
  tagSelectedFilters: "Selected tag conditions",
  tagFilterClear: "Clear tag conditions",
  tagFilterChoose: (kind: string, value: string) => `Filter by ${kind}: ${value}`,
  tagFilterRemove: (kind: string, value: string) => `Remove condition ${kind}: ${value}`,
  tagMore: (count: number) => `View ${count} more tags`,
  tagYearsAllHint: "A track cannot have two production years. Use OR to match either year.",
  tagFilterLoadFailed: "Tags could not be loaded. Existing results may be out of date; rescan to retry.",
  tagNoMatches: "No matching tracks. Adjust the text, new-only or tag conditions.",
  emptyHintDesktop:
    "Open the Music folder, put audio files in it, then pick “Rescan” from the ⋮ menu to bring them into the library.",
  emptyHintAndroid:
    "Put audio files in the Music folder, then pick “Rescan” from the ⋮ menu to bring them into the library. The ⋮ menu’s “Show log” tells you where that folder is.",

  // --- Multi-select / bulk add ---
  selectMode: "Select",
  selectModeLabel: "Select several tracks",
  selectTrackLabel: (title: string) => `Select ${title}`,
  selectAll: "Select all",
  selectNone: "Clear",
  selectedCount: (n: number) => `${n} selected`,
  addSelected: "Add to queue",
  enqueueManyAdded: (n: number) =>
    n === 1 ? "Added 1 track" : `Added ${n} tracks`,
  enqueueManySkipped: (n: number) =>
    n === 1 ? "1 already queued" : `${n} already queued`,
  enqueueManyRejected: (n: number) =>
    n === 1 ? "1 not Funkot" : `${n} not Funkot`,
  enqueueManyNotes: (notes: string) => ` (${notes})`,
  listSeparator: ", ",

  // --- History ---
  historyHeading: "History",
  historyByTrack: "By track",
  historyByTime: "In order",
  historyEmpty: "Nothing played yet",
  historyLogEmpty:
    "No plays recorded yet. The order tracks played in is kept from here on; play counts from before it are on the “By track” tab.",
  playCount: (n: number) => (n === 1 ? "1 play" : `${n} plays`),
  playedToday: (time: string) => `Today ${time}`,
  playedYesterday: (time: string) => `Yesterday ${time}`,
  clearTrackPlayCountItem: "Clear play count for this song",
  confirmClearTrackPlayCount: (title: string) =>
    `Clear the play count for “${title}”? Play order history will remain. This cannot be undone.`,
  confirmRemovePlayLogEntry: (title: string, time: string) =>
    `Remove the play of “${title}” at ${time} from play order history? The song's play count will remain. This cannot be undone.`,
  clearedTrackPlayCount: "Cleared play count for this song",
  clearTrackPlayCountFailed: "Could not clear play count",
  removeTrackFromPlayLogItem: "Remove this song from play order",
  removedTrackFromPlayLog: "Removed this song from play order",
  removeTrackFromPlayLogFailed: "Could not remove from play order",

  // --- Music folder ---
  pickMusicFolderPrompt: "Pick a Music folder",
  pickMusicFolder: "Pick Music folder",
  changeMusicFolder: "Change Music folder",
  openMusicFolder: "Open Music folder",
  musicDirUnchanged: "Nothing changed",
  musicDirChanged: (path: string) => `Music folder changed: ${path}`,
  musicDirChangedRestart: (path: string) =>
    `Music folder changed: ${path} (auto-select switches over after a restart)`,
  musicDirUnavailable: (path: string) => `Cannot open the configured music folder: ${path}`,
  musicDirErrNotAbsolute: "Pick a folder with an absolute path",
  musicDirErrNotFound: "That folder does not exist",
  musicDirErrNotADirectory: "Pick a folder, not a file",
  musicDirErrNotReadable: "That folder cannot be read",
  musicDirErrContainsAppData: "A folder containing the app’s data folder cannot be used",
  musicDirErrUnsupportedPlatform: "This device cannot change it",
  musicDirErrGeneric: "Could not change the Music folder",

  // --- Overflow menu ---
  rescan: "Rescan",
  scanFound: (count: number) => `Found ${count} ${count === 1 ? "track" : "tracks"}`,
  scanBusy: "A scan is already running",
  allowNonFunkotItem: (on: boolean) => `Play non-Funkot too: ${on ? "ON" : "OFF"}`,
  allowNonFunkotToast: (on: boolean) =>
    on
      ? "Non-Funkot tracks can be queued and auto-selected"
      : "Non-Funkot tracks are excluded from queueing and auto-select",
  labelingModeItem: (on: boolean, pending: boolean) =>
    `Labeling mode: ${on ? "ON" : "OFF"}${pending ? " (from the next start)" : ""}`,
  labelingModeToast: (on: boolean, pending: boolean) =>
    pending
      ? `Labeling mode: ${on ? "ON" : "OFF"} (takes effect from the next start)`
      : on
        ? "Labeling mode: ON (plays the first 20 seconds only)"
        : "Labeling mode: OFF",
  clearLabelsItem: "Clear labels",
  confirmClearLabels: "Clear all labels?",
  clearedLabels: "Cleared labels",
  clearLabelsFailed: "Could not clear labels",
  clearPlayLogItem: "Clear play order history",
  confirmClearPlayLog: "Clear play order history?",
  clearedPlayLog: "Cleared play order history",
  clearPlayLogFailed: "Could not clear play order history",
  clearPlayCountsItem: "Clear per-song play counts",
  confirmClearPlayCounts: "Clear per-song play counts?",
  clearedPlayCounts: "Cleared per-song play counts",
  clearPlayCountsFailed: "Could not clear per-song play counts",
  sendFeedback: "Send feedback",
  languageItem: (name: string) => `Language: ${name}`,

  // --- Edit: flagged list ---
  roleOutgoing: "Outgoing",
  roleIncoming: "Incoming",
  noFlagged: "No transitions to fix",
  seeAllTracks: "See all tracks",
  dismissFlag: "〔Dismiss〕",
  unanalyzed: "Not analyzed",
  /// Stand-in title for a flagged track that is no longer in the library.
  /// The host sends an empty title with `missing: true`; the wording lives
  /// here so it stays in one catalogue with everything else.
  missingTrack: "Track not in the library",

  // --- Edit: flagged detail ---
  backToList: "← Back to list",
  flagCount: (n: number) => `${n}×`,
  listenTransitionTo: (title: string) => `Listen to the transition into “${title}”`,
  listenTransitionFrom: (title: string) => `Listen to the transition out of “${title}”`,
  listenAgain: "Listen again",
  confirmAction: "〔Confirm〕",
  cancelAction: "〔Cancel〕",

  // --- Edit: chip editor ---
  intro: "Intro",
  outro: "Outro",
  chipScale: "short ←──────→ long",
  outroHint: "Longer means the switch starts earlier",
  introHint: "Longer skips more of the intro and comes in on a short run-up",

  // --- Edit: all tracks ---
  rootFolder: "(root)",
  colLabel: "label",

  // --- Share-sheet import (Android) ---
  importedSummary: (tracks: number, skipped: number, failed: number) => {
    const notes: string[] = [];
    if (skipped > 0) notes.push(`${skipped} unsupported`);
    if (failed > 0) notes.push(`${failed} failed`);
    const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
    return `Imported ${tracks} ${tracks === 1 ? "track" : "tracks"}${suffix}`;
  },
  importProblems: (skipped: number, failed: number) => {
    const notes: string[] = [];
    if (skipped > 0) notes.push(`Could not import ${skipped} file(s) in an unsupported format`);
    if (failed > 0) notes.push(`Failed to import ${failed} file(s)`);
    return notes.join(". ");
  },
};

/// The shape every locale has to satisfy. Derived rather than hand-written so
/// adding a key to `en` is the only edit needed to make the other two fail.
type MessageValue<T> = T extends (...args: infer Args) => unknown
  ? (...args: Args) => string
  : string;

export type Messages = {
  [Key in keyof typeof en]: MessageValue<(typeof en)[Key]>;
};
