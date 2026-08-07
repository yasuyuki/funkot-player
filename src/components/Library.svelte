<script lang="ts">
  import { store } from "../lib/state.svelte";
  import type { TrackRow } from "../lib/tauri";

  type SortKey = "title" | "artist";

  let query = $state("");
  let sortKey = $state<SortKey>("title");
  let busy = $state<Record<string, boolean>>({});

  let analysis = $derived(store.analysis);
  let libraryScan = $derived(store.libraryScan);

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
    const filtered = store.libraryList.filter((r) => matches(r, q));
    const sorted = filtered.slice().sort((a, b) => {
      if (sortKey === "artist") {
        const byArtist = a.artist.localeCompare(b.artist, "ja");
        if (byArtist !== 0) return byArtist;
      }
      return a.title.localeCompare(b.title, "ja");
    });
    return sorted;
  });

  function toggleSort() {
    sortKey = sortKey === "title" ? "artist" : "title";
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
</script>

<section class="library">
  <h2 class="heading">ライブラリ</h2>

  <!-- Sticky so search stays reachable while scrolling hundreds of rows. -->
  <div class="toolbar">
    <input
      class="search"
      type="search"
      placeholder="検索"
      bind:value={query}
      aria-label="ライブラリを検索"
    />
    <button type="button" class="sort" onclick={toggleSort}>
      {sortKey === "title" ? "曲名順▾" : "アーティスト順▾"}
    </button>
  </div>

  {#if libraryScan}
    <p class="progress">
      {#if libraryScan.phase === "walking"}
        スキャン中…
      {:else}
        スキャン中 {libraryScan.found}曲を確認中 {libraryScan.done}/{libraryScan.found}
      {/if}
    </p>
  {/if}
  {#if analysis}
    <p class="progress">解析中 {analysis.done}/{analysis.total}: {analysis.name}</p>
  {/if}

  <!-- Fixed row height keeps a virtual-list swap possible later (YAGNI now). -->
  <ul class="list">
    {#each rows as row (row.path)}
      <li class="row" class:non-funkot={isNonFunkot(row)}>
        <div class="text">
          <div class="title">{row.title}</div>
          <div class="sub">
            <span class="artist">{row.artist || "—"}</span>
            <span class="dur">{formatDuration(row.duration_secs)}</span>
          </div>
        </div>
        <!-- Unanalysed tracks can still be enqueued (legacy behaviour). -->
        <button
          type="button"
          class="add"
          disabled={addDisabled(row)}
          onclick={() => onAdd(row.path)}
          aria-label={`${row.title} をキューに追加`}
        >+</button>
      </li>
    {/each}
  </ul>
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

  .sort {
    width: auto;
    flex: 0 0 auto;
    font-size: var(--font-size-sm);
    padding: var(--space-sm) var(--space-md);
    background: var(--color-transport-secondary-bg);
    color: var(--color-transport-secondary-text);
  }

  .progress {
    margin: 0 0 var(--space-sm);
    font-size: var(--font-size-sm);
    color: var(--color-status-starting);
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
    font-size: var(--font-size-md);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.3;
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
