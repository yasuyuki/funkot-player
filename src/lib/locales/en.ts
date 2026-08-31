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
  transitionIn: (clock: string) => `Switch in ${clock}`,
  moveUpLabel: "Move up",
  moveDownLabel: "Move down",
  removeLabel: "Remove",
  queueErrTooLate: "Too late to change this one",
  queueErrStale: "The queue changed",
  queueErrAuditioning: "Cannot edit while auditioning",
  queueErrGeneric: "Could not update the queue",

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
  emptyHintDesktop:
    "Open the Music folder, put audio files in it, then pick “Rescan” from the ⋮ menu to bring them into the library.",
  emptyHintAndroid:
    "Put audio files in the Music folder, then pick “Rescan” from the ⋮ menu to bring them into the library. The ⋮ menu’s “Show log” tells you where that folder is.",

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
  clearLabelsItem: "Clear labels and play history",
  confirmClearLabels: "Clear all labels and play history?",
  clearedLabels: "Cleared labels and play history",
  clearLabelsFailed: "Could not clear labels and play history",
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
