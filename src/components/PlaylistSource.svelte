<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { i18n } from "../lib/i18n.svelte";
  import { toast } from "../lib/toast.svelte";
  import { ui } from "../lib/ui.svelte";
  let { compact = false }: { compact?: boolean } = $props();
  let t = $derived(i18n.t);
  let open = $state(false), query = $state(""), createName = $state(""), busy = $state(false);
  let chooseButton: HTMLButtonElement;
  let searchInput = $state<HTMLInputElement | null>(null);
  function closePicker() { open = false; queueMicrotask(() => chooseButton?.focus()); }
  let source = $derived(store.queue?.source ?? null);
  let current = $derived(store.destinationName ?? t.playlistNormal);
  let lists = $derived((store.catalog?.lists ?? []).filter((list) => list.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  async function run(action: Parameters<typeof store.doPlaylist>[0]) { if (busy) return; busy = true; const result = await store.doPlaylist(action); if (!result) toast.notify(t.playlistError(store.lastError ?? "busy")); busy = false; return result; }
  async function select(id: string | null) { const result = await run({ kind: "select", id }); if (result) closePicker(); }
  async function create() {
    const name = createName.trim(); if (!name || busy) return;
    busy = true;
    const created = await store.doPlaylist({ kind: "create", name });
    if (!created) { toast.notify(t.playlistError(store.lastError ?? "busy")); busy = false; return; }
    createName = "";
    const id = created.created_id;
    if (id) {
      const selected = await store.doPlaylist({ kind: "select", id });
      if (!selected) toast.notify(t.playlistCreateSavedSelectionFailed(name, t.playlistError(store.lastError ?? "busy")));
      else closePicker();
    } else closePicker();
    busy = false;
  }
  $effect(() => {
    if (!open) return;
    queueMicrotask(() => searchInput?.focus());
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") closePicker(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  });
</script>

<div class:compact class="source">
  {#if compact}<span class="destination">{t.playlistDestination("")}</span>{/if}
  <button type="button" class="choose" bind:this={chooseButton} aria-label={compact ? t.playlistDestination(current) : current} aria-expanded={open} onclick={() => (open ? closePicker() : (open = true))} title={current}>{current}<span aria-hidden="true">▾</span></button>
  {#if open}
    <div class="picker" role="dialog" aria-label={t.playlistChoose}>
      <input aria-label={t.playlistSearch} bind:this={searchInput} bind:value={query} placeholder={t.playlistSearch} />
      <button type="button" class:active={source?.playlist_id === null} disabled={!store.canPlaylistMutate || busy} onclick={() => select(null)}>{t.playlistNormal}</button>
      {#each lists as list (list.id)}
        <div class="list-row"><button type="button" class:active={source?.playlist_id === list.id} disabled={!store.canPlaylistMutate || busy} onclick={() => select(list.id)} title={list.name}><span class="list-name">{list.name}</span><small>{t.playlistCount(list.remaining, list.total)}</small></button><button type="button" class="view" onclick={() => { void store.browsePlaylist(list.id); if (compact) { open = false; ui.setPlaySub("queue"); window.scrollTo(0, 0); } else closePicker(); }} aria-label={t.playlistBrowseLabel(list.name)}>{t.playlistBrowse}</button></div>
      {/each}
      <form onsubmit={(event) => { event.preventDefault(); void create(); }}>
        <input aria-label={t.playlistNewName} bind:value={createName} />
        <button type="submit" disabled={!store.canPlaylistMutate || busy || !createName.trim()}>{t.playlistCreateUse}</button>
      </form>
    </div>
  {/if}
</div>

<style>
  .source { position: relative; display: flex; gap: var(--space-sm); align-items: center; min-width: 0; }
  .choose { width: auto; min-width: 0; flex: 1 1 auto; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--color-transport-secondary-bg); color: var(--color-transport-secondary-text); }
  .compact { min-width: 0; max-width: 70%; }
  .compact .destination { flex: 0 0 auto; }
  .destination { color: var(--color-text-dim); font-size: var(--font-size-sm); white-space: nowrap; }
  .picker { position: absolute; z-index: 20; top: calc(100% + var(--space-sm)); right: 0; min-width: min(22rem, 95vw); max-height: min(65vh, 32rem); overflow: auto; padding: var(--space-sm); background: var(--color-menu-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); box-shadow: 0 8px 24px #0006; }
  .picker > button, .picker input, .picker form { width: 100%; margin: 0 0 var(--space-sm); }
  .picker > button, .list-row > button:first-child { text-align: left; background: transparent; color: var(--color-text); display: flex; justify-content: space-between; gap: var(--space-md); }
  .picker > button.active, .list-row > button.active { outline: 2px solid var(--color-accent-bg); }
  .list-row { display: flex; gap: var(--space-sm); margin-bottom: var(--space-sm); }.list-row > button:first-child { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; }.list-name { display: block; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }.picker .list-row > .view { width: auto; white-space: nowrap; background: transparent; color: var(--color-text-dim); border: 1px solid var(--color-border); font-size: var(--font-size-sm); padding: var(--space-sm); }
  small { color: var(--color-text-dim); white-space: nowrap; }
  .picker form { display: flex; gap: var(--space-sm); margin: 0; } .picker form button { width: auto; flex: 0 0 auto; }
  @media (max-width: 47.99rem) {
    .picker { position: fixed; left: var(--space-lg); right: var(--space-lg); top: 7rem; min-width: 0; width: auto; max-height: calc(100vh - 9rem); }
  }
</style>
