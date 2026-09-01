<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { openMusicDir, type TrackRow } from "../lib/tauri";
  import { showLibraryEmpty } from "../lib/library-empty";
  import {
    nextLibrarySortKey,
    sortLibraryRows,
    type LibrarySortKey,
  } from "../lib/library-sort";
  import { toast } from "../lib/toast.svelte";
  import { i18n } from "../lib/i18n.svelte";
  import { musicDirErrorMessage } from "../lib/messages";

  let t = $derived(i18n.t);

  let query = $state("");
  let sortKey = $state<LibrarySortKey>("recent");
  let newOnly = $state(false);
  let busy = $state<Record<string, boolean>>({});
  let openMusicBusy = $state(false);
  let setMusicBusy = $state(false);

  let analysis = $derived(store.analysis);
  let libraryScan = $derived(store.libraryScan);
  let musicDirNeeded = $derived(!!store.dirs?.music_dir_needed);
  let libraryEmpty = $derived(
    showLibraryEmpty(store.libraryList.length, musicDirNeeded, libraryScan),
  );
  let musicDirConfigurable = $derived(!!store.dirs?.music_dir_configurable);

  function formatDuration(secs: number | null): string {
    if (secs === null || secs === undefined) return "-";
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function matches(row: TrackRow, q: string): boolean {
    if (!q) return true;
    const hay = `${row.title}\n${row.artist}\n${store.relName(row.path)}`.toLowerCase();
    return hay.includes(q);
  }

  let rows = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const arrivalPaths = store.newArrivalPaths;
    const filtered = store.libraryList.filter((r) => {
      if (newOnly && !arrivalPaths.has(r.path)) return false;
      return matches(r, q);
    });
    return sortLibraryRows(filtered, sortKey);
  });

  function toggleSort() {
    sortKey = nextLibrarySortKey(sortKey);
  }

  function toggleNewOnly() {
    newOnly = !newOnly;
  }

  async function onAdd(path: string) {
    if (busy[path]) return;
    busy = { ...busy, [path]: true };
    try {
      await store.doEnqueue(path);
    } finally {
      const next = { ...busy };
      delete next[path];
      busy = next;
    }
  }

  function isNonFunkot(row: TrackRow): boolean {
    return row.analyzed && !row.is_funkot;
  }

  function addDisabled(row: TrackRow): boolean {
    return !!busy[row.path] || (isNonFunkot(row) && !store.allowNonFunkot);
  }

  async function onSetMusicDir() {
    if (setMusicBusy) return;
    setMusicBusy = true;
    try {
      const result = await store.doSetMusicDir();
      if (!result.ok) {
        toast.notify(musicDirErrorMessage(t, result.error));
      } else if (!result.changed) {
        toast.notify(t.musicDirUnchanged);
      } else if (result.restartRequired) {
        toast.notify(t.musicDirChangedRestart(store.dirs?.music_dir ?? ""));
      } else {
        toast.notify(t.musicDirChanged(store.dirs?.music_dir ?? ""));
      }
    } finally {
      setMusicBusy = false;
    }
  }

  async function onOpenMusicDir() {
    if (openMusicBusy) return;
    openMusicBusy = true;
    try {
      const path = await openMusicDir();
      toast.notify(path);
    } catch (err) {
      toast.notify(String(err));
    } finally {
      openMusicBusy = false;
    }
  }
</script>

<section class="library">
  <h2 class="heading">{t.libraryHeading}</h2>

  <!-- Sticky so search stays reachable while scrolling hundreds of rows. -->
  <div class="toolbar">
    <input
      class="search"
      type="search"
      placeholder={t.searchPlaceholder}
      bind:value={query}
      aria-label={t.searchLabel}
    />
    <button
      type="button"
      class="filter"
      class:on={newOnly}
      aria-pressed={newOnly}
      onclick={toggleNewOnly}
    >{t.newOnly}</button>
    <button type="button" class="sort" onclick={toggleSort}>
      {sortKey === "recent" ? t.sortRecent : sortKey === "title" ? t.sortTitle : t.sortArtist}
    </button>
  </div>

  {#if libraryScan && !musicDirNeeded}
    <p class="progress">
      {#if libraryScan.phase === "walking"}
        {t.scanningWalking}
      {:else}
        {t.scanningHashing(libraryScan.found, libraryScan.done)}
      {/if}
    </p>
  {/if}
  {#if analysis}
    <p class="progress">{t.analyzing(analysis.done, analysis.total, analysis.name)}</p>
  {/if}

  {#if musicDirNeeded}
    <div class="empty">
      <p class="empty-title">{t.pickMusicFolderPrompt}</p>
      <div class="empty-actions">
        {#if musicDirConfigurable}
          <button
            type="button"
            class="set-music"
            disabled={setMusicBusy}
            onclick={onSetMusicDir}
          >{t.pickMusicFolder}</button>
        {/if}
      </div>
    </div>
  {:else if libraryEmpty}
    <div class="empty">
      <p class="empty-title">{t.noTracks}</p>
      <!-- Desktop only, same platform test as OverflowMenu's folder items:
           Android's music folder is under `Android/data`, which no file
           manager has been able to reach since Android 11, so `open_music_dir`
           can only report the path there. Store requirement 10.1.2.10 is a
           Microsoft Store rule, so hiding the button on Android costs nothing;
           the path stays visible in ⋮ → show log (see LogView). -->
      {#if musicDirConfigurable}
        <p class="empty-hint">{t.emptyHintDesktop}</p>
        <button
          type="button"
          class="open-music"
          disabled={openMusicBusy}
          onclick={onOpenMusicDir}
        >{t.openMusicFolder}</button>
      {:else}
        <p class="empty-hint">{t.emptyHintAndroid}</p>
      {/if}
    </div>
  {:else}
    <!-- Fixed row height keeps a virtual-list swap possible later (YAGNI now). -->
    <ul class="list">
      {#each rows as row (row.path)}
        <li class="row" class:non-funkot={isNonFunkot(row)}>
          <div class="text">
            <div class="title">
              <span class="title-text">{row.title}</span>
              {#if store.isNewArrival(row.path)}
                <span class="new-badge">NEW</span>
              {/if}
            </div>
            <div class="sub">
              <span class="artist">{row.artist || t.noLabel}</span>
              <span class="dur">{formatDuration(row.duration_secs)}</span>
            </div>
          </div>
          <!-- Unanalysed tracks can still be enqueued (legacy behaviour). -->
          <button
            type="button"
            class="add"
            disabled={addDisabled(row)}
            onclick={() => onAdd(row.path)}
            aria-label={t.addToQueueLabel(row.title)}
          >+</button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .library {
    margin-top: var(--space-xl);
  }

  .heading {
    margin: 0 0 var(--space-md);
    font-size: var(--font-size-md);
    font-weight: 600;
    color: var(--color-text);
  }

  .toolbar {
    position: sticky;
    /* Same calc as body padding-top in tokens.css: sticky `top: 0` would
       park under the Android status bar / cutout once the toolbar sticks. */
    top: calc(var(--space-xl) + env(safe-area-inset-top, 3rem));
    z-index: 5;
    display: flex;
    gap: var(--space-sm);
    padding: var(--space-sm) 0;
    background: var(--color-bg);
  }

  .search {
    flex: 1;
    min-width: 0;
    font-size: var(--font-size-md);
    padding: var(--space-sm) var(--space-md);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-menu-bg);
    color: var(--color-text);
  }

  .filter,
  .sort {
    width: auto;
    flex: 0 0 auto;
    font-size: var(--font-size-sm);
    padding: var(--space-sm) var(--space-md);
    background: var(--color-transport-secondary-bg);
    color: var(--color-transport-secondary-text);
  }

  .filter.on {
    outline: 2px solid var(--color-accent-text);
    outline-offset: -2px;
  }

  .progress {
    margin: 0 0 var(--space-sm);
    font-size: var(--font-size-sm);
    color: var(--color-status-starting);
  }

  .empty {
    margin: 0;
    padding: var(--space-md);
    color: var(--color-text-dim);
    font-size: var(--font-size-sm);
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-sm);
  }

  .empty-title {
    margin: 0 0 var(--space-sm);
    font-size: var(--font-size-md);
    font-weight: 600;
    color: var(--color-text);
  }

  .empty-hint {
    margin: 0 0 var(--space-md);
    line-height: 1.4;
  }

  .empty-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
  }

  .set-music,
  .open-music {
    width: auto;
    font-size: var(--font-size-sm);
    padding: var(--space-sm) var(--space-md);
  }

  .set-music {
    background: var(--color-transport-primary-bg);
    color: var(--color-transport-primary-text);
  }

  .open-music {
    background: var(--color-transport-secondary-bg);
    color: var(--color-transport-secondary-text);
  }

  .open-music:disabled {
    background: var(--color-transport-disabled-bg);
    color: var(--color-transport-disabled-text);
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-md);
    height: var(--library-row-height);
    border-bottom: 1px solid var(--color-border);
  }

  .row.non-funkot {
    opacity: 0.45;
    color: var(--color-text-dim);
  }

  .text {
    min-width: 0;
    flex: 1;
  }

  .title {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    font-size: var(--font-size-md);
    line-height: 1.3;
    min-width: 0;
  }

  .title-text {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .new-badge {
    flex: 0 0 auto;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.35rem;
    border-radius: var(--radius-sm);
    background: var(--color-new-arrival-badge-bg);
    color: var(--color-new-arrival-badge-text);
  }

  .sub {
    display: flex;
    gap: var(--space-md);
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
    line-height: 1.3;
  }

  .artist {
    min-width: 0;
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dur {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
  }

  .add {
    width: auto;
    min-width: 2.6rem;
    padding: var(--space-sm) var(--space-md);
    font-size: var(--font-size-lg);
    background: var(--color-transport-secondary-bg);
    color: var(--color-transport-secondary-text);
  }

  .add:disabled {
    background: var(--color-transport-disabled-bg);
    color: var(--color-transport-disabled-text);
  }
</style>
