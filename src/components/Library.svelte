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
  import { enqueueManyMessage, musicDirErrorMessage } from "../lib/messages";
  import {
    addAll,
    clearSelection,
    selectAllState,
    toggleSelected,
  } from "../lib/selection";
  import SelectionBar from "./SelectionBar.svelte";
  import PlaylistSource from "./PlaylistSource.svelte";
  import TrackMenu from "./TrackMenu.svelte";
  import { createLongPress, type MenuPoint } from "../lib/track-menu";
  import { tagTargets, tagEditSelection, enqueueSelection } from "../lib/tag-edit";
  import { tagEditorSession } from "../lib/tag-editor.svelte";
  import { buildTagIndex, matchesTagFilter, type TagChoice, type TagFilter as TagFilterState } from "../lib/tag-filter";
  import TagFilter from "./TagFilter.svelte";
  import TagChips from "./TagChips.svelte";
  import FavoriteButton from "./FavoriteButton.svelte";

  let t = $derived(i18n.t);

  let query = $state("");
  let sortKey = $state<LibrarySortKey>("recent");
  let newOnly = $state(false);
  let selectedTags = $state<TagChoice[]>([]);
  let tagMode = $state<"all" | "any">("all");
  let yearUnset = $state(false);
  let tagIndex = $derived(buildTagIndex(store.libraryList, store.trackTags));
  let tagFilter = $derived<TagFilterState>({ keys: selectedTags.map(tag => tag.key), mode: tagMode, yearUnset });
  function chooseTag(tag: TagChoice) {
    if (!selectedTags.some(item => item.key === tag.key)) selectedTags = [...selectedTags, { key: tag.key, kind: tag.kind, value: tag.value }];
  }
  function clearTagFilters() { selectedTags = []; yearUnset = false; }
  let busy = $state<Record<string, boolean>>({});
  let selectMode = $state(false);
  let selected = $state<Set<string>>(new Set());
  let addManyBusy = $state(false);
  let openMusicBusy = $state(false);
  let setMusicBusy = $state(false);
  let menu = $state<{ path: string; at: MenuPoint; opener?: HTMLElement | null } | null>(null);
  const press = createLongPress<string>((path, at) => {
    menu = { path, at, opener: null };
  });

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
      return matches(r, q) && matchesTagFilter(tagIndex, r.path, tagFilter);
    });
    return sortLibraryRows(filtered, sortKey);
  });

  let hasActiveCriteria = $derived(
    query.trim() !== "" || newOnly || selectedTags.length > 0 || yearUnset,
  );

  let nowPlayingPath = $derived(store.player?.now_playing ?? null);
  let queuedCounts = $derived.by(() => {
    const counts = new Map<string, number>();
    const playlist = store.activePlaylist;
    if (store.queue?.source?.playlist_id && playlist) {
      for (const entry of playlist.rows) {
        if (entry.status === "pending" || entry.status === "preparing" || entry.status === "prepared") {
          counts.set(entry.path, (counts.get(entry.path) ?? 0) + 1);
        }
      }
    } else if (store.queue) {
      if (store.queue.reserved) {
        counts.set(store.queue.reserved.path, (counts.get(store.queue.reserved.path) ?? 0) + 1);
      }
      for (const entry of store.queue.pending) {
        counts.set(entry.path, (counts.get(entry.path) ?? 0) + 1);
      }
    }
    return counts;
  });

  let titleCounts = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const item of store.libraryList) {
      counts.set(item.title, (counts.get(item.title) ?? 0) + 1);
    }
    return counts;
  });

  let enqueuePaths = $derived(enqueueSelection(sortLibraryRows(store.libraryList, sortKey), selected, store.allowNonFunkot));

  let visiblePaths = $derived(rows.map((r) => r.path));

  let selectedCount = $derived(selected.size);
  let tagSelectedRows = $derived(tagEditSelection(rows, selected));
  let enqueueCount = $derived(enqueuePaths.length);
  let visibleTagCount = $derived(tagSelectedRows.filter((row) => {
    const state = store.trackTags?.tracks[row.path];
    return !!state?.content_hash && state.content_hash === row.content_hash;
  }).length);
  let allState = $derived(selectAllState(selected, visiblePaths));

  function toggleSort() {
    sortKey = nextLibrarySortKey(sortKey);
  }

  function toggleNewOnly() {
    newOnly = !newOnly;
  }

  function toggleSelectMode() {
    selectMode = !selectMode;
    if (!selectMode) selected = clearSelection();
  }

  function onToggleRow(path: string) {
    selected = toggleSelected(selected, path);
  }
  function openTagEditor(rowsToEdit: TrackRow[], title: string, opener: HTMLElement | null) {
    const snapshot = store.trackTags;
    if (!snapshot) { toast.notify(t.tagError("identity_unavailable")); return; }
    const targets = tagTargets(rowsToEdit, snapshot);
    if (targets.length !== rowsToEdit.length) { toast.notify(t.tagError("identity_unavailable")); return; }
    tagEditorSession.open({ targets, revision: snapshot.revision, title, initialStates: targets.map((target) => snapshot.tracks[target.path]!), opener });
  }

  function openRowMenu(event: MouseEvent, path: string) {
    event.stopPropagation();
    const button = event.currentTarget as HTMLElement;
    if (menu?.path === path) {
      menu = null;
      return;
    }
    const rect = button.getBoundingClientRect();
    menu = { path, at: { x: rect.left, y: rect.bottom }, opener: button };
  }

  async function onAddSelected() {
    if (addManyBusy) return;
    const paths = enqueuePaths;
    if (paths.length === 0) return;
    const destination = store.destinationLabel;
    addManyBusy = true;
    try {
      const result = await store.doEnqueueMany(paths);
      if (result) {
        toast.notify(t.playlistAddResult(enqueueManyMessage(t, result), destination));
        selected = clearSelection();
      } else toast.notify(t.playlistError(store.lastError ?? "busy"));
    } finally {
      addManyBusy = false;
    }
  }

  async function onAdd(path: string) {
    if (busy[path]) return;
    const destination = store.destinationLabel;
    busy = { ...busy, [path]: true };
    try {
      const result = await store.doEnqueue(path);
      if (result) toast.notify(t.playlistAddResult(enqueueManyMessage(t, result), destination));
      else toast.notify(t.playlistError(store.lastError ?? "busy"));
    } finally {
      const next = { ...busy };
      delete next[path];
      busy = next;
    }
  }

  function isNonFunkot(row: TrackRow): boolean {
    return row.analyzed && !row.is_funkot;
  }

  function gated(row: TrackRow): boolean {
    return isNonFunkot(row) && !store.allowNonFunkot;
  }

  function addDisabled(row: TrackRow): boolean {
    return !!busy[row.path] || gated(row) || !store.canAddToSource;
  }
</script>

<section class="library">
  <div class="toolbar">
    <h2 class="heading">{t.libraryHeading}</h2>
    <input
      class="search"
      type="search"
      placeholder={t.searchPlaceholder}
      bind:value={query}
      aria-label={t.searchLabel}
    />
    <button type="button" class="sort" onclick={toggleSort}>
      {sortKey === "recent" ? t.sortRecent : sortKey === "title" ? t.sortTitle : t.sortArtist}
    </button>
    <div class="secondary" class:on={newOnly}>
      <button
        type="button"
        class="filter"
        class:on={newOnly}
        aria-pressed={newOnly}
        onclick={toggleNewOnly}
      >{t.newOnly}</button>
    </div>
    <button
      type="button"
      class="filter"
      class:on={selectMode}
      aria-pressed={selectMode}
      aria-label={t.selectModeLabel}
      onclick={toggleSelectMode}
    >{t.selectMode}</button>
    <TagFilter candidates={tagIndex.candidates} selected={selectedTags} mode={tagMode} {yearUnset}
      onchoose={chooseTag} onremove={key => selectedTags = selectedTags.filter(tag => tag.key !== key)}
      onmode={mode => tagMode = mode} onunset={enabled => yearUnset = enabled} onclear={clearTagFilters} />
    <div class="dest"><PlaylistSource compact /></div>
    {#if hasActiveCriteria}
      <div class="filter-status" role="status">
        <span class="match-count">{rows.length} / {store.libraryList.length}</span>
        {#if newOnly}
          <button type="button" class="quiet status-chip" onclick={toggleNewOnly}>{t.newOnly} ×</button>
        {/if}
        {#if query.trim()}
          <button type="button" class="quiet status-chip" onclick={() => (query = "")}>“{query.trim()}” ×</button>
        {/if}
      </div>
    {/if}
    {#if selectMode}
      <SelectionBar
        totalSelected={selectedCount}
        {enqueueCount}
        {visibleTagCount}
        tagUnavailable={visibleTagCount !== tagSelectedRows.length}
        {allState}
        busy={addManyBusy}
        addDisabled={!store.canAddToSource}
        addLabel={t.playlistAddLabel(t.playlistTrackCount(enqueueCount), store.destinationLabel)}
        onSelectAll={() => (selected = addAll(selected, visiblePaths))}
        onClear={() => (selected = clearSelection())}
        onAdd={onAddSelected}
        onEditTags={(event) => openTagEditor(
          tagSelectedRows,
          tagSelectedRows.length === 1
            ? (tagSelectedRows[0]?.title || store.relName(tagSelectedRows[0]?.path ?? ""))
            : t.selectedCount(tagSelectedRows.length),
          event.currentTarget as HTMLElement,
        )}
      />
    {/if}
  </div>

  {#if !store.trackTags || !store.trackTags.ready}<p class="progress" role="status">{t.tagMetadataStatus("pending")}</p>{/if}
  {#if store.trackTagsError}<p class="progress" role="alert">{t.tagFilterLoadFailed}</p>{/if}
  {#if store.libraryList.length > 0 && rows.length === 0}<p class="empty" role="status">{t.tagNoMatches}</p>{/if}

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
            class="set-music primary"
            disabled={setMusicBusy}
            onclick={async () => {
              if (setMusicBusy) return;
              setMusicBusy = true;
              try {
                const result = await store.doSetMusicDir();
                if (!result.ok) toast.notify(musicDirErrorMessage(t, result.error));
                else if (!result.changed) toast.notify(t.musicDirUnchanged);
                else if (result.restartRequired) toast.notify(t.musicDirChangedRestart(store.dirs?.music_dir ?? ""));
                else toast.notify(t.musicDirChanged(store.dirs?.music_dir ?? ""));
              } finally {
                setMusicBusy = false;
              }
            }}
          >{t.pickMusicFolder}</button>
        {/if}
      </div>
    </div>
  {:else if libraryEmpty}
    <div class="empty">
      <p class="empty-title">{t.noTracks}</p>
      {#if musicDirConfigurable}
        <p class="empty-hint">{t.emptyHintDesktop}</p>
        <button
          type="button"
          class="open-music"
          disabled={openMusicBusy}
          onclick={async () => {
            if (openMusicBusy) return;
            openMusicBusy = true;
            try {
              toast.notify(await openMusicDir());
            } catch (err) {
              toast.notify(String(err));
            } finally {
              openMusicBusy = false;
            }
          }}
        >{t.openMusicFolder}</button>
      {:else}
        <p class="empty-hint">{t.emptyHintAndroid}</p>
      {/if}
    </div>
  {:else}
    <ul class="list">
      {#each rows as row (row.path)}
        {@const isPlaying = nowPlayingPath === row.path}
        {@const queuedCount = queuedCounts.get(row.path) ?? 0}
        {@const isDuplicateTitle = (titleCounts.get(row.title) ?? 0) > 1}
        <li
          class="row"
          class:non-funkot={isNonFunkot(row)}
          class:playing={isPlaying}
          class:queued={queuedCount > 0}
          onpointerdown={(e) => press.down(e, row.path)}
          onpointermove={press.move}
          onpointerup={press.cancel}
          onpointercancel={press.cancel}
          oncontextmenu={(e) => press.context(e, row.path)}
        >
          {#if selectMode}
            <input
              type="checkbox"
              class="pick"
              checked={selected.has(row.path)}
              onchange={() => onToggleRow(row.path)}
              aria-label={t.selectTrackLabel(row.title)}
            />
          {/if}
          <div class="text" title={`${row.title} — ${row.artist || t.noLabel} (${store.relName(row.path)})`}>
            <div class="title">
              <span class="title-text">{row.title}</span>
              {#if isPlaying}
                <span class="state-badge playing">{t.phasePlaying}</span>
              {:else if queuedCount > 0}
                <span class="state-badge queued">✓{queuedCount > 1 ? `×${queuedCount}` : ""}</span>
              {/if}
              {#if store.isNewArrival(row.path)}
                <span class="new-badge">NEW</span>
              {/if}
            </div>
            {#if selectMode && (!row.content_hash || store.trackTags?.tracks[row.path]?.content_hash !== row.content_hash)}
              <span class="identity-unavailable">{t.tagIdentityUnavailable}</span>
            {/if}
            <div class="sub">
              <span class="artist">{row.artist || t.noLabel}</span>
              {#if isDuplicateTitle}
                <span class="path-badge">{store.relName(row.path)}</span>
              {/if}
              <TagChips state={tagIndex.tracks.get(row.path)?.state ?? null} />
              <span class="dur">{formatDuration(row.duration_secs)}</span>
            </div>
          </div>
          {#if !selectMode}
            <div class="row-actions">
              <FavoriteButton path={row.path} contentHash={row.content_hash} title={row.title} />
              <button
                type="button"
                class="row-menu quiet icon-button"
                aria-label={`${t.labelMenuLabel}: ${row.title}`}
                title={`${t.labelMenuLabel}: ${row.title}`}
                aria-haspopup="menu"
                aria-expanded={menu?.path === row.path}
                onclick={(e) => openRowMenu(e, row.path)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <circle cx="5" cy="12" r="2" fill="currentColor" />
                  <circle cx="12" cy="12" r="2" fill="currentColor" />
                  <circle cx="19" cy="12" r="2" fill="currentColor" />
                </svg>
              </button>
              <button
                type="button"
                class="add primary icon-button"
                disabled={addDisabled(row)}
                onclick={() => onAdd(row.path)}
                aria-label={t.playlistAddLabel(row.title, store.destinationLabel || t.playlistNormal)}
              >+</button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if menu}
    <TrackMenu path={menu?.path ?? null} at={menu?.at ?? { x: 0, y: 0 }} opener={menu?.opener ?? null} onclose={() => (menu = null)} />
  {/if}
</section>

<style>
  .heading {
    margin: 0;
    font-size: var(--font-size-md);
    font-weight: 600;
    color: var(--color-text);
  }

  .toolbar {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-xs);
    padding: var(--space-sm) 0;
    background: var(--color-bg);
  }
  .secondary { display: flex; gap: var(--space-xs); }
  .toolbar :global(.tag-filter) { order: 5; }
  .toolbar :global(.active-filter-strip) { order: 5; }
  .filter-status {
    flex-basis: 100%;
    order: 4;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
  }
  .match-count {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-sm);
    background: var(--color-panel-bg);
    color: var(--color-text);
  }
  .toolbar :global(.bar) { order: 6; }
  .dest { display: none; flex: 0 1 7rem; min-width: 0; }
  .dest :global(.compact) { max-width: 100%; }
  .dest :global(.destination) { display: none; }
  .dest :global(.choose) {
    background: var(--color-dest-bg);
    border-color: var(--color-dest-border);
    border-radius: 999px;
    padding-inline: 0.45rem;
  }
  .dest :global(.choose)::before { content: "+ → "; color: var(--color-text-dim); flex: 0 0 auto; white-space: pre; }

  @container shell not (min-width: 48rem) {
    .heading { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    .dest { display: block; }
    .secondary { display: none; order: 4; flex-basis: 100%; }
    .toolbar:has(:global(.tag-filter)) .secondary { display: flex; }
    .toolbar:has(.secondary.on) :global(.toggle) { outline: 2px solid var(--color-accent-text); outline-offset: -2px; }
    .search { flex: 1 1 3rem; min-width: var(--control-target); padding-inline: 0.4rem; }
    .sort, .filter, .toolbar :global(.toggle) { padding-inline: 0.42rem; }
  }

  .pick {
    flex: 0 0 auto;
    width: 1.2rem;
    height: 1.2rem;
    margin: 0;
    accent-color: var(--color-accent-bg);
  }

  .search {
    flex: 1 1 4.5rem;
    min-width: var(--control-target);
    border: 1px solid var(--color-border);
  }
  .identity-unavailable { font-size: var(--font-size-sm); color: var(--color-text-dim); overflow-wrap: anywhere; }

  .filter,
  .sort {
    width: auto;
    flex: 0 0 auto;
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
    gap: var(--space-xs);
    min-height: var(--row-min);
    box-sizing: border-box;
    padding: 1px 0 1px 4px;
    border-bottom: 1px solid var(--color-border);
    border-inline-start: 3px solid transparent;
    user-select: none;
    -webkit-user-select: none;
  }

  .row.queued:not(.playing) {
    border-inline-start-color: var(--color-row-queued-border);
  }

  .row.playing {
    background: var(--color-row-playing-bg);
    border-inline-start-color: var(--color-row-playing-border);
  }

  .row.non-funkot {
    color: var(--color-text-dim);
  }

  .text {
    min-width: 0;
    flex: 1;
  }

  .title {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--font-size-md);
    line-height: 1.25;
    min-width: 0;
  }

  .title-text {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .state-badge {
    flex: 0 0 auto;
    font-size: 0.72rem;
    font-weight: 600;
    line-height: 1.25;
    padding: 1px 0.35rem;
    border-radius: 2px;
    font-variant-numeric: tabular-nums;
  }

  .state-badge.playing {
    background: var(--color-badge-playing-bg);
    color: var(--color-badge-playing-text);
  }

  .state-badge.queued {
    background: var(--color-badge-queued-bg);
    color: var(--color-badge-queued-text);
  }

  .new-badge {
    flex: 0 0 auto;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 0.05rem 0.32rem;
    border-radius: var(--radius-sm);
    background: var(--color-new-arrival-badge-bg);
    color: var(--color-new-arrival-badge-text);
  }

  .sub {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
    line-height: 1.25;
  }
  .sub :global(.tag-summary) { margin: 0; flex: 0 1 auto; min-width: 0; max-width: 50%; }

  .artist {
    min-width: 0;
    flex: 0 1 auto;
    max-width: 45%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .path-badge {
    flex: 0 1 auto;
    max-width: 30%;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 0.3rem;
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    line-height: 1.25;
    background: var(--color-pill-year-bg);
    color: var(--color-pill-year-text);
  }

  .dur {
    flex: 0 0 auto;
    margin-left: auto;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  .row-actions {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .row-menu svg {
    display: block;
    width: 1.15rem;
    height: 1.15rem;
  }

  .add {
    width: auto;
    flex: 0 0 auto;
  }

  .add:disabled {
    background: var(--color-transport-disabled-bg);
    color: var(--color-transport-disabled-text);
  }

  @media (forced-colors: active) {
    .row.playing, .row.queued {
      border-inline-start-color: Highlight;
    }
  }
</style>
