<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { openMusicDir, type TrackRow } from "../lib/tauri";
  import {
    nextLibrarySortKey,
    sortLibraryRows,
    type LibrarySortKey,
  } from "../lib/library-sort";
  import { toast } from "../lib/toast.svelte";
  import NewArrivalsBanner from "./NewArrivalsBanner.svelte";

  let query = $state("");
  let sortKey = $state<LibrarySortKey>("recent");
  let newOnly = $state(false);
  let busy = $state<Record<string, boolean>>({});
  let openMusicBusy = $state(false);
  let setMusicBusy = $state(false);

  let analysis = $derived(store.analysis);
  let libraryScan = $derived(store.libraryScan);
  let libraryEmpty = $derived(store.libraryList.length === 0);
  let musicDirNeeded = $derived(!!store.dirs?.music_dir_needed);
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

  /// Error code (`set_music_dir`) → Japanese toast text. Keep in sync with
  /// `OverflowMenu.svelte` / `src-tauri/src/lib.rs` / `src/lib/tauri.ts`.
  function toastForMusicDirError(error: string): string {
    switch (error) {
      case "not_absolute":
        return "絶対パスのフォルダを選んでください";
      case "not_found":
        return "そのフォルダが見つかりません";
      case "not_a_directory":
        return "フォルダを選んでください";
      case "not_readable":
        return "そのフォルダを読み取れません";
      case "contains_app_data":
        return "アプリのデータフォルダを含むフォルダは選べません";
      case "unsupported_platform":
        return "この端末では変更できません";
      default:
        return "Musicフォルダを変更できませんでした";
    }
  }

  async function onSetMusicDir() {
    if (setMusicBusy) return;
    setMusicBusy = true;
    try {
      const result = await store.doSetMusicDir();
      if (!result.ok) {
        toast.notify(toastForMusicDirError(result.error));
      } else if (!result.changed) {
        toast.notify("変更しませんでした");
      } else if (result.restartRequired) {
        toast.notify(
          `Musicフォルダを変更しました: ${store.dirs?.music_dir}（自動選曲は再起動後に切り替わります）`,
        );
      } else {
        toast.notify(`Musicフォルダを変更しました: ${store.dirs?.music_dir}`);
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
    <button
      type="button"
      class="filter"
      class:on={newOnly}
      aria-pressed={newOnly}
      onclick={toggleNewOnly}
    >新着のみ</button>
    <button type="button" class="sort" onclick={toggleSort}>
      {sortKey === "recent"
        ? "新着順▾"
        : sortKey === "title"
          ? "曲名順▾"
          : "アーティスト順▾"}
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

  <NewArrivalsBanner />

  {#if musicDirNeeded}
    <div class="empty">
      <p class="empty-title">Musicフォルダを選んでください</p>
      <div class="empty-actions">
        {#if musicDirConfigurable}
          <button
            type="button"
            class="set-music"
            disabled={setMusicBusy}
            onclick={onSetMusicDir}
          >Musicフォルダを選ぶ</button>
        {/if}
      </div>
    </div>
  {:else if libraryEmpty}
    <div class="empty">
      <p class="empty-title">曲がありません</p>
      <!-- Desktop only, same platform test as OverflowMenu's folder items:
           Android's music folder is under `Android/data`, which no file
           manager has been able to reach since Android 11, so `open_music_dir`
           can only report the path there. Store requirement 10.1.2.10 is a
           Microsoft Store rule, so hiding the button on Android costs nothing;
           the path stays visible in ⋮ → ログを表示 (see LogView). -->
      {#if musicDirConfigurable}
        <p class="empty-hint">
          Musicフォルダを開いて音声ファイルを入れたあと、⋮ メニューの「再スキャン」でライブラリに反映します。
        </p>
        <button
          type="button"
          class="open-music"
          disabled={openMusicBusy}
          onclick={onOpenMusicDir}
        >Musicフォルダを開く</button>
      {:else}
        <p class="empty-hint">
          音声ファイルをMusicフォルダへ入れたあと、⋮ メニューの「再スキャン」でライブラリに反映します。
          フォルダの場所は ⋮ メニューの「ログを表示」に出ます。
        </p>
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
