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
  queue_state: { reserved: null, pending: [], in_flight: [], reserved_swappable: false, reserved_prepared: false, transition_in_secs: null, folder_pos: 0, folder_len: 0, source: { playlist_id: "night", generation: 2, revision: 4 }, catalog_revision: 4, playlist_store_status: "ready", playlist: { id: "night", name: "Night set with an intentionally very long name", revision: 4, run_id: 2, total: 5, ended: false, skipped: 0, rows: [{ entry_id: "a", path: rows[0].path, title: rows[0].title, artist: rows[0].artist, status: "prepared", reason: null }, { entry_id: "a-again", path: rows[0].path, title: rows[0].title, artist: rows[0].artist, status: "pending", reason: null }] } },
  playlist_catalog: { revision: 4, active_id: "night", generation: 2, store_status: "ready", lists: [{ id: "night", name: "Night set with an intentionally very long name", revision: 4, total: 5, remaining: 2 }, { id: "empty", name: "Empty list", revision: 1, total: 0, remaining: 0 }] },
  playlist_command: { created_id: null, undo_id: "undo-1", added: 1, rejected: 0, skipped: 0 },
  playlist_entries: { id: "night", name: "Night set with an intentionally very long name", revision: 4, run_id: 2, total: 5, ended: false, skipped: 1, rows: [{ entry_id: "played", path: rows[1].path, title: rows[1].title, artist: rows[1].artist, status: "played", reason: null }, { entry_id: "current", path: rows[2].path, title: rows[2].title, artist: rows[2].artist, status: "current", reason: null }, { entry_id: "missing", path: rows[3].path, title: rows[3].title, artist: rows[3].artist, status: "missing", reason: "missing" }, { entry_id: "a", path: rows[0].path, title: rows[0].title, artist: rows[0].artist, status: "pending", reason: null }, { entry_id: "a-again", path: rows[0].path, title: rows[0].title, artist: rows[0].artist, status: "prepared", reason: null }] },
  refresh_library: rows, list_track_tags: snapshot, list_new_arrivals: [],
  list_play_history: { log: [], tracks: [], log_total: 0 },
};
const calls: Array<{ command: string; args: unknown }> = [];
const delayed = new Set<string>();
const nextFailures = new Map<string, unknown>();
const pending = new Map<string, Array<{ resolve: (value: unknown) => void; reject: (reason: unknown) => void }>>();
const fixtureControl = {
  calls,
  setReply(command: string, value: unknown) { replies[command] = JSON.parse(JSON.stringify(value)); },
  delayNext(command: string) { delayed.add(command); },
  failNext(command: string, reason: unknown) { nextFailures.set(command, reason); },
  resolve(command: string, value: unknown) { pending.get(command)?.shift()?.resolve(value); },
  reject(command: string, reason: unknown) { pending.get(command)?.shift()?.reject(reason); },
};
(window as unknown as { __uiFixture: typeof fixtureControl }).__uiFixture = fixtureControl;
const ipc: TauriIpc = {
  async invoke<T>(command: string, args?: unknown): Promise<T> {
    calls.push({ command, args: args === undefined ? undefined : JSON.parse(JSON.stringify(args)) });
    if (!Object.prototype.hasOwnProperty.call(replies, command)) {
      // Fail visibly even when the production store catches the rejection.
      console.error(`Unsupported UI fixture command: ${command}`);
      throw new Error(`Unsupported UI fixture command: ${command}`);
    }
    if (nextFailures.has(command)) { const reason = nextFailures.get(command); nextFailures.delete(command); throw reason; }
    if (delayed.delete(command)) return new Promise<T>((resolve, reject) => {
      const queue = pending.get(command) ?? [];
      queue.push({ resolve: (value) => resolve(value as T), reject });
      pending.set(command, queue);
    });
    if (command === "playlist_entries" && (args as { id?: string } | undefined)?.id === "empty") return structuredClone(replies.playlist_entries_empty ?? { id: "empty", name: "Empty list", revision: 1, run_id: 1, total: 0, ended: false, skipped: 0, rows: [] }) as T;
    return structuredClone(replies[command]) as T;
  },
  async listen() { return () => {}; },
};
installIpcForTesting(ipc);
// App's singleton store starts IPC on import; install the seam first.
await import("../../src/main");
