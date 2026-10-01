<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { toast } from "../lib/toast.svelte";
  import { i18n } from "../lib/i18n.svelte";
  import { queueErrorMessage } from "../lib/messages";
  import type { QueueItem, PlaylistEntryView } from "../lib/tauri";
  import PlaylistSource from "./PlaylistSource.svelte";

  let t = $derived(i18n.t);
  let reserved = $derived(store.queue?.reserved ?? null);
  let pending = $derived(store.queue?.pending ?? []);
  let reservedSwappable = $derived(store.queue?.reserved_swappable ?? false);
  let reservedPrepared = $derived(store.queue?.reserved_prepared ?? true);
  let transitionInSecs = $derived(store.queue?.transition_in_secs ?? null);
  let items = $derived(reserved !== null ? [reserved, ...pending] : pending);
  let playlist = $derived(store.activePlaylist);
  let editor = $derived(store.browsedPlaylist);
  let target = $derived(editor ?? playlist);
  let shownRows = $derived(target?.rows ?? []);
  let menu = $state(false);
  let menuButton: HTMLButtonElement;
  let dialogElement = $state<HTMLDialogElement | null>(null);
  let dialogInput = $state<HTMLInputElement | null>(null);
  let dialogAction = $state<"save" | "rename" | "delete" | null>(null);
  let dialogTarget = $state<{ id: string; name: string } | null>(null);
  let dialogName = $state("");
  let dialogBusy = $state(false);
  let selectedPlaylist = $state<{ id: string; scope: "all" | "remaining"; entryId: string } | null>(null);
  let selectedQueue = $state<{ item: QueueItem; index: number; signature: string; source: string | null } | null>(null);
  let toolbar = $state<HTMLElement | null>(null);
  let busy = $state(false);

  let selectedPlaylistIndex = $derived(findSelectedPlaylistIndex(selectedPlaylist));
  let selectedPlaylistRow = $derived(selectedPlaylistIndex < 0 ? null : shownRows[selectedPlaylistIndex]);
  let selectedQueueIndex = $derived(findSelectedQueueIndex(selectedQueue));
  let selectedQueueItem = $derived(selectedQueueIndex < 0 ? null : items[selectedQueueIndex]);

  function sameItem(a: QueueItem, b: QueueItem): boolean { return JSON.stringify(a) === JSON.stringify(b); }
  function findSelectedPlaylistIndex(selection: typeof selectedPlaylist): number {
    if (!selection || selection.id !== target?.id || selection.scope !== (editor ? "all" : "remaining")) return -1;
    return shownRows.findIndex((row) => row.entry_id === selection.entryId);
  }
  // Normal queue rows have no stable occurrence id. A later poll is accepted
  // only if it proves the selected payload occurs exactly once.
  function findUniqueQueueIndex(item: QueueItem): number {
    if (!item) return -1;
    const matches = items.map((candidate, index) => sameItem(candidate, item) ? index : -1).filter((index) => index >= 0);
    return matches.length === 1 ? matches[0] : -1;
  }
  function queueSignature(): string { return JSON.stringify(items); }
  function findSelectedQueueIndex(selection: typeof selectedQueue): number {
    if (!selection || selection.source !== (store.queue?.source?.playlist_id ?? null)) return -1;
    if (selection.signature === queueSignature() && sameItem(items[selection.index], selection.item)) return selection.index;
    return findUniqueQueueIndex(selection.item);
  }
  function selectQueue(item: QueueItem, index: number) { selectedPlaylist = null; selectedQueue = { item, index, signature: queueSignature(), source: store.queue?.source?.playlist_id ?? null }; }
  function selectPlaylist(row: PlaylistEntryView) { selectedQueue = null; selectedPlaylist = target ? { id: target.id, scope: editor ? "all" : "remaining", entryId: row.entry_id } : null; }
  function clearSelection() { selectedQueue = null; selectedPlaylist = null; }
  function retainFocus(control: EventTarget | null) { const element = control instanceof HTMLElement ? control : null; queueMicrotask(() => element?.focus()); }
  function transitionBadge(secs: number): string { const n = Math.max(0, Math.floor(secs)); return t.transitionIn(`${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`); }
  function reservedBlocksMove(from: number, to: number): boolean { return reserved !== null && !reservedSwappable && (from === 0 || to === 0); }
  function reservedBlocksRemove(index: number): boolean { return reserved !== null && !reservedSwappable && index === 0; }
  function originBlocksMove(from: number, to: number): boolean { return items[from]?.origin !== items[to]?.origin; }
  function normalMoveAllowed(to: number): boolean { return selectedQueueIndex >= 0 && to >= 0 && to < items.length && !reservedBlocksMove(selectedQueueIndex, to) && !originBlocksMove(selectedQueueIndex, to); }

  async function runNormalMove(delta: number, control: EventTarget | null) {
    if (!selectedQueueItem || busy) return;
    const from = selectedQueueIndex, to = from + delta;
    if (!normalMoveAllowed(to)) return;
    busy = true;
    const err = await store.doReorder(from, to, selectedQueueItem);
    if (err) { busy = false; toast.notify(queueErrorMessage(t, err)); if (err === "stale") clearSelection(); return; }
    selectedQueue = sameItem(items[to], selectedQueueItem)
      ? { item: selectedQueueItem, index: to, signature: queueSignature(), source: store.queue?.source?.playlist_id ?? null }
      : null;
    busy = false;
    retainFocus(control);
  }
  async function runNormalRemove() {
    if (!selectedQueueItem || busy || reservedBlocksRemove(selectedQueueIndex)) return;
    busy = true;
    const err = await store.doDequeue(selectedQueueIndex, selectedQueueItem);
    busy = false;
    if (err) toast.notify(queueErrorMessage(t, err));
    clearSelection();
  }
  async function playlistMove(to: number, control: EventTarget | null) {
    if (!target || !selectedPlaylistRow || busy || to < 0 || to >= shownRows.length) return;
    busy = true;
    const result = await store.doPlaylist({ kind: "move", id: target.id, entry_id: selectedPlaylistRow.entry_id, to, scope: editor ? "all" : "remaining" });
    busy = false;
    if (!result) toast.notify(t.playlistError(store.lastError ?? "busy")); else retainFocus(control);
  }
  async function playlistRemove() {
    if (!target || !selectedPlaylistRow || busy) return;
    const row = selectedPlaylistRow;
    busy = true;
    const result = await store.doPlaylist({ kind: "remove", id: target.id, entry_id: row.entry_id });
    busy = false;
    if (!result) { toast.notify(t.playlistError(store.lastError ?? "busy")); return; }
    clearSelection();
    if (result.undo_id) toast.show(t.playlistRemoved, async () => !!await store.doPlaylist({ kind: "undo_remove", undo_id: result.undo_id! }));
  }
  async function restart(id = playlist?.id) { if (id && !await store.doPlaylist({ kind: "restart", id })) toast.notify(t.playlistError(store.lastError ?? "busy")); }
  function openDialog(action: "save" | "rename" | "delete") { dialogTarget = target ? { id: target.id, name: target.name } : null; dialogAction = action; dialogName = action === "rename" ? dialogTarget?.name ?? "" : ""; menu = false; }
  function closeDialog() { if (dialogElement?.open) dialogElement.close(); dialogAction = null; dialogTarget = null; queueMicrotask(() => menuButton?.focus()); }
  async function confirmDialog() {
    if (!dialogAction || dialogBusy) return;
    const name = dialogName.trim(); if (!name) return;
    dialogBusy = true;
    let action: import("../lib/tauri").PlaylistAction;
    if (dialogAction === "save") action = { kind: "save_queue", name };
    else if (dialogAction === "rename" && dialogTarget) action = { kind: "rename", id: dialogTarget.id, name };
    else if (dialogAction === "delete" && dialogTarget && name === dialogTarget.name) action = { kind: "delete", id: dialogTarget.id, confirm_name: name };
    else { dialogBusy = false; return; }
    const result = await store.doPlaylist(action); dialogBusy = false;
    if (result) closeDialog(); else toast.notify(t.playlistError(store.lastError ?? "busy"));
  }
  async function duplicate() { if (!target) return; menu = false; if (!await store.doPlaylist({ kind: "duplicate", id: target.id })) toast.notify(t.playlistError(store.lastError ?? "busy")); }
  $effect(() => { if (selectedPlaylist !== null && selectedPlaylistIndex < 0) selectedPlaylist = null; });
  $effect(() => { if (!busy && selectedQueue !== null && selectedQueueIndex < 0) selectedQueue = null; });
  $effect(() => { if (target) selectedQueue = null; });
  $effect(() => { if (!dialogAction) return; queueMicrotask(() => { if (dialogElement && !dialogElement.open) dialogElement.showModal(); dialogInput?.focus(); }); });
  $effect(() => { if (!menu) return; const close = (e: KeyboardEvent) => { if (e.key === "Escape") { menu = false; menuButton?.focus(); } }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); });
</script>

<section class="queue">
  <div class="head"><h2 class="heading">{t.queueHeading}</h2><PlaylistSource /><button type="button" class="quiet icon-button menu" bind:this={menuButton} aria-label={t.playlistMenu} aria-expanded={menu} onclick={() => (menu = !menu)}>⋯</button></div>
  {#if menu}<div class="playlist-menu">{#if target}<button type="button" class="quiet" onclick={() => { menu = false; if (editor) store.closeBrowsedPlaylist(); else if (playlist) void store.browsePlaylist(playlist.id); }}>{editor ? t.playlistShowRemaining : t.playlistEditAll}</button>{#if playlist && target.id === playlist.id}<button type="button" class="quiet" onclick={() => void restart()}>{t.playlistRestart}</button>{/if}<button type="button" class="quiet" onclick={() => openDialog("rename")}>{t.playlistRename}</button><button type="button" class="quiet" onclick={() => void duplicate()}>{t.playlistDuplicate}</button><button type="button" class="danger" onclick={() => { if (target?.id === playlist?.id) { menu = false; toast.notify(t.playlistError("active_list")); } else openDialog("delete"); }}>{t.playlistDelete}</button>{:else}<button type="button" class="quiet" onclick={() => openDialog("save")}>{t.playlistSaveQueue}</button>{/if}</div>{/if}
  {#if target}
    {#if editor}<div class="editor-heading"><div><h3>{t.playlistEditing}: {target.name}</h3><p>{t.playlistPlaybackSource}: {playlist?.name ?? t.playlistNormal} · {t.playlistAllScope} · {t.editImmediate}</p></div><button type="button" class="quiet" onclick={() => store.closeBrowsedPlaylist()}>{t.close}</button></div>{/if}
    <p class="playlist-count">{target.ended ? t.playlistEnded : t.playlistCount(editor ? target.rows.filter((row) => row.status === "pending" || row.status === "preparing" || row.status === "prepared").length : target.rows.length, target.total)}{target.skipped ? ` · ${t.playlistSkipped(target.skipped)}` : ""}{#if !editor} · {t.playlistRemainingScope}{/if}</p>
    {#if shownRows.length === 0}{#if target.ended && target.total > 0}<button type="button" class="quiet" disabled={!store.canPlaylistMutate} onclick={() => void restart(target.id)}>{t.playlistRestart}</button>{:else}<p class="empty">{t.playlistEmpty}</p>{/if}
    {:else}<ul class="list">{#each shownRows as row (row.entry_id)}<li class="row playlist-row" class:selected={selectedPlaylist?.entryId === row.entry_id}><button type="button" class="row-select" disabled={busy} aria-label={t.selectTrackLabel(row.title)} aria-pressed={selectedPlaylist?.entryId === row.entry_id} onclick={() => selectPlaylist(row)}><span class="text"><span class="title">{row.title}</span><span class="artist">{row.artist}</span>{#if editor || row.status === "preparing" || row.status === "prepared"}<span class="row-status">{t.playlistStatus(row.status)}</span>{/if}{#if editor && row.reason}<span class="row-reason">{t.playlistFailureReason(row.reason)}</span>{/if}</span></button></li>{/each}</ul>{/if}
  {:else if items.length === 0}<p class="empty">{t.queueEmpty}</p>
  {:else}<ul class="list">{#each items as item, index (item.path + ":" + item.origin + ":" + index)}<li class="row" class:reserved={reserved !== null && index === 0} class:selected={selectedQueueIndex === index}><button type="button" class="row-select" disabled={busy} aria-label={t.selectTrackLabel(store.titleForPath(item.path))} aria-pressed={selectedQueueIndex === index} onclick={() => selectQueue(item, index)}><span class="text"><span class="title-line"><span class="title">{store.titleForPath(item.path)}</span>{#if item.origin === "automatic"}<span class="automatic">{t.automaticSelection}</span>{/if}</span><span class="artist">{store.artistForPath(item.path)}</span></span>{#if reserved !== null && index === 0}<span class="badge" class:preparing={!reservedPrepared}>{!reservedPrepared ? t.queuePreparing : reservedSwappable && transitionInSecs !== null ? transitionBadge(transitionInSecs) : t.queuePrepared}</span>{/if}</button></li>{/each}</ul>{/if}
  {#if selectedPlaylistRow || selectedQueueItem}
    <div class="selection-toolbar edit-footer" bind:this={toolbar} aria-label={t.selectModeLabel}>
      <p class="selection-target">
        {selectedPlaylistRow?.title ?? store.titleForPath(selectedQueueItem!.path)}
        <span>{selectedPlaylistRow?.artist ?? store.artistForPath(selectedQueueItem!.path)}</span>
      </p>
      <button
        type="button"
        class="quiet"
        disabled={busy || !!selectedPlaylistRow && !store.canPlaylistMutate || (selectedPlaylistRow ? selectedPlaylistIndex === 0 : !normalMoveAllowed(selectedQueueIndex - 1))}
        onclick={(event) => selectedPlaylistRow ? void playlistMove(selectedPlaylistIndex - 1, event.currentTarget) : void runNormalMove(-1, event.currentTarget)}
      >{t.moveUpLabel}</button>
      <button
        type="button"
        class="quiet"
        disabled={busy || !!selectedPlaylistRow && !store.canPlaylistMutate || (selectedPlaylistRow ? selectedPlaylistIndex === shownRows.length - 1 : !normalMoveAllowed(selectedQueueIndex + 1))}
        onclick={(event) => selectedPlaylistRow ? void playlistMove(selectedPlaylistIndex + 1, event.currentTarget) : void runNormalMove(1, event.currentTarget)}
      >{t.moveDownLabel}</button>
      <button
        type="button"
        class="danger"
        aria-label={selectedPlaylistRow ? t.playlistRemoveLabel(selectedPlaylistRow.title) : t.removeLabel}
        disabled={busy || !!selectedPlaylistRow && !store.canPlaylistMutate || (!!selectedQueueItem && reservedBlocksRemove(selectedQueueIndex))}
        onclick={() => selectedPlaylistRow ? void playlistRemove() : void runNormalRemove()}
      >{t.removeLabel}</button>
      <button type="button" class="quiet" onclick={clearSelection}>{t.close}</button>
    </div>
  {/if}
  {#if store.catalog && !["ready", "missing"].includes(store.playlistStoreStatus)}<p class="store-warning" role="alert">{store.playlistStoreStatus === "persist_failed" ? t.playlistSaveFailedRetry : t.playlistReadOnly}</p>{/if}
  {#if dialogAction}<dialog bind:this={dialogElement} class="dialog" aria-label={dialogAction === "delete" ? t.playlistDelete : dialogAction === "rename" ? t.playlistRename : t.playlistSaveQueue} oncancel={(event) => { event.preventDefault(); closeDialog(); }}><form onsubmit={(e) => { e.preventDefault(); void confirmDialog(); }}><h3>{dialogAction === "delete" ? t.playlistDelete : dialogAction === "rename" ? t.playlistRename : t.playlistSaveQueue}</h3>{#if dialogAction === "save"}<p class="save-scope">{t.playlistSaveQueueScope}</p>{/if}<label>{dialogAction === "delete" ? t.playlistConfirmName(dialogTarget?.name ?? "") : t.playlistNewName}<input bind:this={dialogInput} bind:value={dialogName} /></label><div class="dialog-actions"><button type="button" class="quiet" onclick={closeDialog}>{t.close}</button><button type="submit" class="primary" class:danger={dialogAction === "delete"} disabled={dialogBusy || !store.canPlaylistMutate || !dialogName.trim() || (dialogAction === "delete" && dialogName !== dialogTarget?.name)}>{dialogAction === "delete" ? t.playlistDelete : t.playlistSave}</button></div></form></dialog>{/if}
</section>

<style>
  .queue { margin-top: var(--space-xl); }.head { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:var(--space-sm); margin-bottom:var(--space-md); }.heading { margin:0; flex:0 0 auto; font-size:var(--font-size-md); font-weight:600; white-space:nowrap; }.head :global(.source) { flex:1 1 auto; min-width:0; }.menu { flex:0 0 auto; }
  .playlist-menu,.dialog-actions { display:flex; flex-wrap:wrap; gap:var(--space-sm); margin:0 0 var(--space-sm); }.playlist-count,.save-scope,.artist,.row-status,.row-reason,.editor-heading p { color:var(--color-text-dim); font-size:var(--font-size-sm); }.playlist-count { margin:0 0 var(--space-sm); }.row-status { color:var(--color-status-playing); }.row-reason { overflow-wrap:anywhere; }.editor-heading { display:flex; flex-wrap:wrap; align-items:start; justify-content:space-between; gap:var(--space-sm); margin-bottom:var(--space-sm); }.editor-heading > div { flex:1 1 15rem; min-width:0; }.editor-heading > button { flex:0 0 auto; }.editor-heading h3,.editor-heading p { margin:0; overflow-wrap:anywhere; }.editor-heading h3 { font-size:var(--font-size-md); }.editor-heading p { margin-top:var(--space-xs); }
  .empty,.store-warning { margin:0; padding:var(--space-md); color:var(--color-text-dim); border:1px dashed var(--color-border); border-radius:var(--radius-sm); }.store-warning { margin-top:var(--space-md); border-style:solid; }.list { list-style:none; margin:0; padding:0; }.row { min-height:var(--queue-row-height); border-bottom:1px solid var(--color-border); }.row.reserved { background:var(--color-queue-reserved-bg); border-left:3px solid var(--color-status-playing); border-radius:var(--radius-sm); }.row.selected { outline:2px solid var(--color-selected-border); outline-offset:-2px; }.row-select { display:flex; width:100%; min-height:var(--queue-row-height); align-items:center; justify-content:space-between; gap:var(--space-md); padding:var(--space-sm) var(--space-md); text-align:left; background:transparent; color:var(--color-text); }.text { display:grid; min-width:0; gap:var(--space-xs); }.title-line { display:flex; min-width:0; gap:var(--space-xs); align-items:center; }.title { min-width:0; font-size:var(--font-size-md); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.artist { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.automatic,.badge { flex:0 0 auto; color:var(--color-text-dim); font-size:var(--font-size-sm); }.badge { color:var(--color-status-playing); }.badge.preparing { color:var(--color-text-dim); }
  .selection-toolbar { align-items:center; margin-top:var(--space-md); }.selection-target { display:grid; min-width:10rem; max-width:100%; margin:0 auto 0 0; font-size:var(--font-size-md); }.selection-target span { color:var(--color-text-dim); font-size:var(--font-size-sm); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.dialog { width:min(30rem, 100%); max-height:90vh; overflow:auto; padding:var(--space-lg); background:var(--color-panel-bg); color:var(--color-text); border:1px solid var(--color-input-border); border-radius:var(--radius-md); }.dialog::backdrop { background:var(--color-backdrop); }.dialog label,.dialog input { display:block; width:100%; margin-top:var(--space-sm); }.dialog-actions { justify-content:end; margin-top:var(--space-lg); }
</style>
