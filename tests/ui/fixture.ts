import { installIpcForTesting, type TrackRow, type TrackTagsSnapshot, type TauriIpc } from "../../src/lib/tauri";

// Synthetic identities only: these files never exist and no native IPC is used.
const titles = ["Pulse", "Midnight on the coast — extended festival reconstruction with a very long title", "Dawn", "Afterglow", "帰り道のリミックス", "Last train"];
const artists = ["DJ Example", "The extraordinarily long artist name featuring Another Imaginary Producer", "A", "Studio Example", "架空のアーティスト", "Guest"];
const rows: TrackRow[] = titles.map((title, i) => ({
  path: `/fixture/music/track-${i + 1}.mp3`, content_hash: String(i + 1).repeat(64),
  title, artist: artists[i], duration_secs: 240 + i * 17,
  analyzed: true, is_funkot: true, label: null,
  intro_bars: 32, outro_structure_bars: 32, outro_bars: 32,
  intro_manual: false, outro_manual: false, intro_low_confidence: false,
  outro_low_confidence: false, played_at_ms: null, added_order: 6 - i,
}));
const snapshot: TrackTagsSnapshot = {
  revision: "fixture-1", ready: true, store_status: "ready",
  tracks: Object.fromEntries(rows.map((row, i) => {
    const effective: TrackTagsSnapshot["tracks"][string]["effective"] = i === 0 ? [] : [
      { key: "genre:funkot", kind: "genre", value: "Funkot", origin: "embedded" },
    ];
    if (i === 1 || i === 3) effective.push(
      { key: "year:2024", kind: "year", value: "2024", origin: "embedded" },
      { key: "custom:late-night", kind: "custom", value: "Late night", origin: "manual" },
      { key: "custom:festival", kind: "custom", value: "Festival closing set with a long tag", origin: "manual" },
    );
    return [row.path, {
      content_hash: row.content_hash, effective,
      manual: { year: { mode: "auto" }, manual_additions: effective.flatMap(tag => tag.origin === "manual" && tag.kind !== "year" ? [{ kind: tag.kind, value: tag.value }] : []), suppressed_auto_tags: [] },
      auto_year: i === 1 || i === 3 ? 2024 : null,
      year_status: i === 1 || i === 3 ? "resolved" : "missing",
      metadata_status: "ready", candidates: [], diagnostics: [],
    }];
  })),
};

const replies: Record<string, unknown> = {
  get_locale: "en",
  app_dirs: { music_dir: "/fixture/music", cache_dir: "/fixture/cache", data_dir: "/fixture/data", music_dir_custom: "/fixture/music", music_dir_unavailable: false, music_dir_needed: false, music_dir_configurable: true },
  take_pending_import: { tracks: 0, skipped: 0, failed: 0, in_flight: false },
  get_allow_non_funkot: false, get_labeling_mode: false,
  player_state: { phase: "idle", paused: false, now_playing: null, previous: null, last_transition: null, auditioning: false, audition_from: null, audition_to: null, position_secs: null, duration_secs: null, history_revision: 0 },
  queue_state: { reserved: null, pending: [], in_flight: [], reserved_swappable: false, reserved_prepared: false, transition_in_secs: null, folder_pos: 0, folder_len: 0 },
  refresh_library: rows, list_track_tags: snapshot, list_new_arrivals: [],
  list_play_history: { log: [], tracks: [], log_total: 0 },
};
const ipc: TauriIpc = {
  async invoke<T>(command: string): Promise<T> {
    if (!Object.prototype.hasOwnProperty.call(replies, command)) {
      // Fail visibly even when the production store catches the rejection.
      console.error(`Unsupported UI fixture command: ${command}`);
      throw new Error(`Unsupported UI fixture command: ${command}`);
    }
    return structuredClone(replies[command]) as T;
  },
  async listen() { return () => {}; },
};
installIpcForTesting(ipc);
// App's singleton store starts IPC on import; install the seam first.
await import("../../src/main");
