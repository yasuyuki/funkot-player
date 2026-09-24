<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { toast } from "../lib/toast.svelte";
  import { i18n } from "../lib/i18n.svelte";
  import { queueErrorMessage } from "../lib/messages";
  import PlaylistSource from "./PlaylistSource.svelte";

  let t = $derived(i18n.t);

  // Per-button busy, not a whole-row lock: tapping ↑ must not freeze ↓/✕
  // (legacy `withBusy` disabled only the tapped button).
  let busy = $state<Record<string, boolean>>({});

  let reserved = $derived(store.queue?.reserved ?? null);
  let pending = $derived(store.queue?.pending ?? []);
  let reservedSwappable = $derived(store.queue?.reserved_swappable ?? false);
  // `?? true`, not `?? false`: before the first poll lands (`store.queue` is
  // still null), `reserved` is also null so the badge doesn't render at all —
  // this default only matters for not flashing "preparing" in that instant.
  let reservedPrepared = $derived(store.queue?.reserved_prepared ?? true);
  let transitionInSecs = $derived(store.queue?.transition_in_secs ?? null);
  /// The list actually shown: `reserved` (if any) folded into the front, so
  /// every row shares the same look and the same ↑↓✕ (src-tauri/src/queue.rs
  /// `QueueEdit`'s doc comment calls this "the displayed list"). Indices into
  /// this array are exactly what `doReorder`/`doDequeue` expect.
  let items = $derived(reserved !== null ? [reserved, ...pending] : pending);
  let isEmpty = $derived(items.length === 0);
  let playlist = $derived(store.activePlaylist);
  let menu = $state(false);
  let menuButton: HTMLButtonElement;
  let dialogInput = $state<HTMLInputElement | null>(null);
  let dialogAction = $state<"save" | "rename" | "delete" | null>(null);
  let dialogTarget = $state<{ id: string; name: string } | null>(null);
  let dialogName = $state("");
  let dialogBusy = $state(false);
  let editor = $derived(store.browsedPlaylist);
  let target = $derived(editor ?? playlist);
  let shownRows = $derived(target?.rows ?? []);

  function transitionBadge(secs: number): string {
    const clamped = Math.max(0, Math.floor(secs));
    const m = Math.floor(clamped / 60);
    const s = clamped % 60;
    return t.transitionIn(`${m}:${s.toString().padStart(2, "0")}`);
  }

  /// Mirrors `queue::edit_displayed`'s `touches_reserved` check: a `Move`
  /// whose `from` or `to` is 0 reaches into the reserved slot (including
  /// `to === 0`, since promoting some other row to the front displaces
  /// `reserved` from it just as surely as moving `reserved` itself would).
  /// Disabled whenever the host would reject it as `"too_late"` anyway.
  function reservedBlocksMove(from: number, to: number): boolean {
    if (reserved === null || reservedSwappable) return false;
    return from === 0 || to === 0;
  }

  /// Manual FIFO and the automatic runway are separate reorder regions.
  /// Adjacent arrows at their boundary stay disabled, matching the host's
  /// `origin_boundary` rejection for stale or non-UI callers.
  function originBlocksMove(from: number, to: number): boolean {
    return items[from]?.origin !== items[to]?.origin;
  }

  /// As `reservedBlocksMove`, for `Remove`.
  function reservedBlocksRemove(index: number): boolean {
    if (reserved === null || reservedSwappable) return false;
    return index === 0;
  }

  async function withBusy(key: string, fn: () => Promise<void>) {
    if (busy[key]) return;
    busy = { ...busy, [key]: true };
    try {
      await fn();
    } finally {
      const next = { ...busy };
      delete next[key];
      busy = next;
    }
  }

  function onUp(index: number) {
    void withBusy(`up:${index}`, async () => {
      const err = await store.doReorder(index, index - 1, items[index]);
      if (err) toast.notify(queueErrorMessage(t, err));
    });
  }

  function onDown(index: number) {
    void withBusy(`down:${index}`, async () => {
      const err = await store.doReorder(index, index + 1, items[index]);
      if (err) toast.notify(queueErrorMessage(t, err));
    });
  }

  function onDel(index: number) {
    void withBusy(`del:${index}`, async () => {
      const err = await store.doDequeue(index, items[index]);
      if (err) toast.notify(queueErrorMessage(t, err));
    });
  }
  async function playlistMove(row: NonNullable<typeof playlist>["rows"][number], to: number) {
    if (!target) return;
    const result = await store.doPlaylist({ kind: "move", id: target.id, entry_id: row.entry_id, to, scope: editor ? "all" : "remaining" });
    if (!result) toast.notify(t.playlistError(store.lastError ?? "busy"));
  }
  async function playlistRemove(row: NonNullable<typeof playlist>["rows"][number]) {
    if (!target) return;
    const result = await store.doPlaylist({ kind: "remove", id: target.id, entry_id: row.entry_id });
    if (!result) { toast.notify(t.playlistError(store.lastError ?? "busy")); return; }
    if (result.undo_id) toast.show(t.playlistRemoved, async () => !!await store.doPlaylist({ kind: "undo_remove", undo_id: result.undo_id! }));
  }
  async function restart(id = playlist?.id) { if (id && !await store.doPlaylist({ kind: "restart", id })) toast.notify(t.playlistError(store.lastError ?? "busy")); }
  function openDialog(action: "save" | "rename" | "delete") { dialogTarget = target ? { id: target.id, name: target.name } : null; dialogAction = action; dialogName = action === "rename" ? dialogTarget?.name ?? "" : ""; menu = false; }
  function closeDialog() { dialogAction = null; dialogTarget = null; queueMicrotask(() => menuButton?.focus()); }
  async function confirmDialog() {
    if (!dialogAction || dialogBusy) return;
    const name = dialogName.trim(); if (!name) return;
    dialogBusy = true;
    let action: import("../lib/tauri").PlaylistAction;
    if (dialogAction === "save") action = { kind: "save_queue", name };
    else if (dialogAction === "rename" && dialogTarget) action = { kind: "rename", id: dialogTarget.id, name };
    else if (dialogAction === "delete" && dialogTarget) {
      if (name !== dialogTarget.name) { dialogBusy = false; return; }
      action = { kind: "delete", id: dialogTarget.id, confirm_name: name };
    }
    else { dialogBusy = false; return; }
    const result = await store.doPlaylist(action);
    dialogBusy = false;
    if (result) closeDialog(); else toast.notify(t.playlistError(store.lastError ?? "busy"));
  }
  async function duplicate() { if (!target) return; menu = false; if (!await store.doPlaylist({ kind: "duplicate", id: target.id })) toast.notify(t.playlistError(store.lastError ?? "busy")); }
  $effect(() => {
    if (!dialogAction) return;
    queueMicrotask(() => dialogInput?.focus());
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") closeDialog(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  });
  $effect(() => {
    if (!menu) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { menu = false; menuButton?.focus(); } };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  });
</script>

<section class="queue">
  <div class="head"><h2 class="heading">{t.queueHeading}</h2><PlaylistSource /><button type="button" class="mini menu" bind:this={menuButton} aria-label={t.playlistMenu} aria-expanded={menu} onclick={() => (menu = !menu)}>⋯</button></div>
  {#if menu}<div class="playlist-menu">
    {#if target}<button type="button" onclick={() => { menu = false; if (editor) store.closeBrowsedPlaylist(); else if (playlist) void store.browsePlaylist(playlist.id); }}>{editor ? t.playlistShowRemaining : t.playlistEditAll}</button>{#if playlist && target.id === playlist.id}<button type="button" onclick={() => void restart()}>{t.playlistRestart}</button>{/if}<button type="button" onclick={() => openDialog("rename")}>{t.playlistRename}</button><button type="button" onclick={() => void duplicate()}>{t.playlistDuplicate}</button><button type="button" onclick={() => { if (target?.id === playlist?.id) { menu = false; toast.notify(t.playlistError("active_list")); } else openDialog("delete"); }}>{t.playlistDelete}</button>
    {:else}<button type="button" onclick={() => openDialog("save")}>{t.playlistSaveQueue}</button>{/if}
  </div>{/if}

  {#if target}
    {#if editor}<div class="editor-heading"><h3>{t.playlistBrowse}: {target.name}</h3><button type="button" class="mini" onclick={() => store.closeBrowsedPlaylist()}>{t.close}</button></div>{/if}
    <p class="playlist-count">{target.ended ? t.playlistEnded : t.playlistCount(editor ? target.rows.filter((row) => row.status === "pending" || row.status === "preparing" || row.status === "prepared").length : target.rows.length, target.total)}{target.skipped ? ` · ${t.playlistSkipped(target.skipped)}` : ""}</p>
    {#if shownRows.length === 0}
      {#if target.ended && target.total > 0}<button type="button" class="restart-empty" disabled={!store.canPlaylistMutate} onclick={() => void restart(target.id)}>{t.playlistRestart}</button>{:else}<p class="empty">{t.playlistEmpty}</p>{/if}
    {:else}<ul class="list">{#each shownRows as row, index (row.entry_id)}
      <li class="row playlist-row"><div class="meta"><div class="text"><div class="title-line"><span class="title">{row.title}</span></div><div class="artist">{row.artist}</div>{#if editor || row.status === "preparing" || row.status === "prepared"}<div class="row-status">{t.playlistStatus(row.status)}</div>{/if}{#if editor && row.reason}<div class="row-reason">{t.playlistFailureReason(row.reason)}</div>{/if}</div></div><div class="trailing"><div class="acts"><button type="button" class="mini" disabled={!store.canPlaylistMutate || index === 0} onclick={() => void playlistMove(row, index - 1)} aria-label={t.moveUpLabel}>↑</button><button type="button" class="mini" disabled={!store.canPlaylistMutate || index === shownRows.length - 1} onclick={() => void playlistMove(row, index + 1)} aria-label={t.moveDownLabel}>↓</button><button type="button" class="mini" disabled={!store.canPlaylistMutate} onclick={() => void playlistRemove(row)} aria-label={t.playlistRemoveLabel(row.title)}>✕</button></div></div></li>
    {/each}</ul>{/if}
  {:else}

  {#if isEmpty}
    <!-- An empty queue is not an empty playlist: DrainPolicy falls back to
         walking the music folder, so we keep the section visible and say so
         rather than vanishing like legacy/index.html did. -->
    <p class="empty">{t.queueEmpty}</p>
  {:else}
    <ul class="list">
      {#each items as item, index (item.path + ":" + item.origin + ":" + index)}
        <li class="row" class:reserved={reserved !== null && index === 0}>
          <div class="meta">
            <div class="text">
              <div class="title-line">
                <span class="title">{store.titleForPath(item.path)}</span>
                {#if item.origin === "automatic"}
                  <svg
                    class="automatic-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    role="img"
                    aria-label={t.automaticSelection}
                  >
                    <title>{t.automaticSelection}</title>
                    <path d="m12 3-1.1 3.1a3 3 0 0 1-1.8 1.8L6 9l3.1 1.1a3 3 0 0 1 1.8 1.8L12 15l1.1-3.1a3 3 0 0 1 1.8-1.8L18 9l-3.1-1.1a3 3 0 0 1-1.8-1.8L12 3Z" />
                    <path d="m19 15-.6 1.7a2 2 0 0 1-1.2 1.2l-1.7.6 1.7.6a2 2 0 0 1 1.2 1.2L19 22l.6-1.7a2 2 0 0 1 1.2-1.2l1.7-.6-1.7-.6a2 2 0 0 1-1.2-1.2L19 15Z" />
                  </svg>
                {/if}
              </div>
              <div class="artist">{store.artistForPath(item.path)}</div>
            </div>
          </div>
          <div class="trailing">
            {#if reserved !== null && index === 0}
              <!-- Reserved = already handed to the engine to play next.
                   Still gets the same ↑↓✕ as every other row
                   (src-tauri/src/queue.rs `edit_displayed`) — only the badge
                   is special, and only the buttons that would touch this
                   slot get disabled once it is too late to swap. Badge has
                   3 states: not yet prepared (still decoding/time-stretching),
                   prepared with a known runway (countdown), or prepared
                   otherwise. -->
              <span class="badge" class:preparing={!reservedPrepared}>
                {!reservedPrepared
                  ? t.queuePreparing
                  : reservedSwappable && transitionInSecs !== null
                    ? transitionBadge(transitionInSecs)
                    : t.queuePrepared}
              </span>
            {/if}
            <div class="acts">
              <button
                type="button"
                class="mini"
                disabled={index === 0 || reservedBlocksMove(index, index - 1) || originBlocksMove(index, index - 1) || !!busy[`up:${index}`]}
                onclick={() => onUp(index)}
                aria-label={t.moveUpLabel}
              >↑</button>
              <button
                type="button"
                class="mini"
                disabled={index === items.length - 1 || reservedBlocksMove(index, index + 1) || originBlocksMove(index, index + 1) || !!busy[`down:${index}`]}
                onclick={() => onDown(index)}
                aria-label={t.moveDownLabel}
              >↓</button>
              <button
                type="button"
                class="mini"
                disabled={reservedBlocksRemove(index) || !!busy[`del:${index}`]}
                onclick={() => onDel(index)}
                aria-label={t.removeLabel}
              >✕</button>
            </div>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
  {/if}
  {#if store.catalog && !["ready", "missing"].includes(store.playlistStoreStatus)}<p class="store-warning" role="alert">{store.playlistStoreStatus === "persist_failed" ? t.playlistSaveFailedRetry : t.playlistReadOnly}</p>{/if}
  {#if dialogAction}<div class="dialog-backdrop"><div class="dialog" role="dialog" aria-modal="true" aria-label={dialogAction === "delete" ? t.playlistDelete : dialogAction === "rename" ? t.playlistRename : t.playlistSaveQueue}><form onsubmit={(e) => { e.preventDefault(); void confirmDialog(); }}><h3>{dialogAction === "delete" ? t.playlistDelete : dialogAction === "rename" ? t.playlistRename : t.playlistSaveQueue}</h3>{#if dialogAction === "save"}<p class="save-scope">{t.playlistSaveQueueScope}</p>{/if}<label>{dialogAction === "delete" ? t.playlistConfirmName(dialogTarget?.name ?? "") : t.playlistNewName}<input bind:this={dialogInput} bind:value={dialogName} /></label><div class="dialog-actions"><button type="button" onclick={() => closeDialog()}>{t.close}</button><button type="submit" disabled={dialogBusy || !store.canPlaylistMutate || !dialogName.trim() || (dialogAction === "delete" && dialogName !== dialogTarget?.name)}>{dialogAction === "delete" ? t.playlistDelete : t.playlistSave}</button></div></form></div></div>{/if}
</section>

<style>
  .queue {
    margin-top: var(--space-xl);
  }

  .heading {
    margin: 0 0 var(--space-md);
    font-size: var(--font-size-md);
    font-weight: 600;
    color: var(--color-text);
  }
  .head { display: flex; align-items: center; gap: var(--space-sm); margin-bottom: var(--space-md); }
  .head .heading { margin: 0; flex: 0 0 auto; white-space: nowrap; } .head :global(.source) { flex: 1 1 auto; min-width: 0; } .menu { width: auto; flex: 0 0 auto; }
  .playlist-menu { display: flex; flex-wrap: wrap; gap: var(--space-sm); margin: 0 0 var(--space-sm); } .playlist-menu button { width: auto; }
  .playlist-count { margin: 0 0 var(--space-sm); color: var(--color-text-dim); font-size: var(--font-size-sm); }
  .row-status { color: var(--color-status-playing); font-size: var(--font-size-sm); }
  .row-reason { color: var(--color-text-dim); font-size: var(--font-size-sm); overflow-wrap: anywhere; }
  .restart-empty { width: auto; background: var(--color-transport-secondary-bg); color: var(--color-transport-secondary-text); }
  .save-scope { color: var(--color-text-dim); font-size: var(--font-size-sm); }
  .editor-heading { display: flex; justify-content: space-between; align-items: start; gap: var(--space-sm); margin-bottom: var(--space-sm); }.editor-heading h3 { margin: 0; font-size: var(--font-size-md); overflow-wrap: anywhere; }.store-warning { color: var(--color-text); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: var(--space-sm); }.dialog-backdrop { position: fixed; z-index: 20; inset: 0; display: grid; place-items: center; padding: var(--space-lg); background: #0009; }.dialog { width: min(30rem, 100%); max-height: 90vh; overflow: auto; padding: var(--space-lg); background: var(--color-menu-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); }.dialog label,.dialog input { display: block; width: 100%; margin-top: var(--space-sm); }.dialog-actions { display: flex; justify-content: end; gap: var(--space-sm); margin-top: var(--space-lg); }.dialog-actions button { width: auto; }.dialog-actions button:first-child { background: var(--color-transport-secondary-bg); color: var(--color-transport-secondary-text); }

  .empty {
    margin: 0;
    padding: var(--space-md);
    color: var(--color-text-dim);
    font-size: var(--font-size-sm);
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-sm);
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    min-height: var(--queue-row-height);
    padding: var(--space-sm) 0;
    border-bottom: 1px solid var(--color-border);
  }

  .row.reserved {
    /* Distinguish the next-up slot without competing with transport greens. */
    background: var(--color-queue-reserved-bg);
    border-left: 3px solid var(--color-status-playing);
    padding-left: var(--space-sm);
    border-radius: var(--radius-sm);
    border-bottom-color: transparent;
    margin-bottom: var(--space-xs);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    min-width: 0;
    flex: 1;
  }

  .text {
    min-width: 0;
  }

  .title-line {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    min-width: 0;
  }

  .title {
    min-width: 0;
    font-size: var(--font-size-md);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .automatic-icon {
    width: 1rem;
    height: 1rem;
    flex: 0 0 auto;
    color: var(--color-text-dim);
  }

  .artist {
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .trailing {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex: 0 0 auto;
  }

  .badge {
    flex: 0 0 auto;
    font-size: var(--font-size-sm);
    color: var(--color-status-playing);
  }

  .badge.preparing {
    color: var(--color-text-dim);
  }

  .acts {
    display: flex;
    gap: var(--space-xs);
    flex: 0 0 auto;
  }

  .mini {
    width: auto;
    min-width: 2.4rem;
    padding: var(--space-sm) var(--space-md);
    font-size: var(--font-size-md);
    background: var(--color-transport-secondary-bg);
    color: var(--color-transport-secondary-text);
  }

  .mini:disabled {
    background: var(--color-transport-disabled-bg);
    color: var(--color-transport-disabled-text);
  }
  @media (max-width: 47.99rem) {
    .playlist-row { flex-wrap: wrap; }
    .playlist-row .meta { flex-basis: 100%; }
    .playlist-row .trailing { width: 100%; justify-content: flex-end; }
  }
</style>
