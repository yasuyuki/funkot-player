<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { openMusicDir, type TrackRow } from "../lib/tauri";
  import { showLibraryEmpty } from "../lib/library-empty";
  import { sortLibraryRows, type LibrarySortKey } from "../lib/library-sort";
  import { ambiguousPaths, upNextPositions } from "../lib/library-rows";
  import { toast } from "../lib/toast.svelte";
  import { i18n } from "../lib/i18n.svelte";
  import { enqueueManyMessage, musicDirErrorMessage, phaseLabel } from "../lib/messages";
  import {
    addAll,
    clearSelection,
    selectAllState,
    toggleSelected,
  } from "../lib/selection";
  import SelectionBar from "./SelectionBar.svelte";
  import PlaylistSource from "./PlaylistSource.svelte";
  import TrackMenu from "./TrackMenu.svelte";
  import { createLongPress, shownVerdict, type MenuPoint } from "../lib/track-menu";
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
  let menu = $state<{ path: string; at: MenuPoint } | null>(null);
  const press = createLongPress<string>((path, at) => {
    menu = { path, at };
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

  // What the list already knows about playback, shown where the eye is while browsing.
  let playingPath = $derived(store.player?.now_playing ?? null);
  let playingWord = $derived(phaseLabel(t, store.player?.phase ?? "idle"));
  let upNext = $derived(upNextPositions(store.queue));
  let ambiguous = $derived(ambiguousPaths(rows));

  // One row at a time opens in place to judge and organise it; the list stays a list.
  let openPath = $state<string | null>(null);
  let detailBusy = $state(false);
  function toggleDetails(path: string) { openPath = openPath === path ? null : path; }
  function closeDetails(event: KeyboardEvent, path: string) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    openPath = null;
    document.getElementById(`row-${path}`)?.focus();
  }
  async function setVerdict(row: TrackRow, verdict: boolean) {
    if (detailBusy) return;
    detailBusy = true;
    const previous = row.label;
    try {
      const updated = await store.doSetLabel(row.path, verdict);
      if (updated) toast.show(verdict ? t.labeledFunkot : t.labeledNotFunkot, async () => (await store.doSetLabel(row.path, previous)) !== null);
    } finally {
      detailBusy = false;
    }
  }
  function tagValues(path: string): string[] {
    return tagIndex.tracks.get(path)?.state?.effective.map((tag) => tag.value) ?? [];
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
  <div class="toolbar">
    <h2 class="heading">{t.libraryHeading}</h2>
    <input
      class="search"
      type="search"
      placeholder={t.searchPlaceholder}
      bind:value={query}
      aria-label={t.searchLabel}
    />
    <div class="secondary" class:on={newOnly}>
    <button
      type="button"
      class="filter"
      class:on={newOnly}
      aria-pressed={newOnly}
      onclick={toggleNewOnly}
    >{t.newOnly}</button>
    <select class="sort" aria-label={t.sortLabel} title={t.sortLabel} bind:value={sortKey}>
      <option value="recent">{t.sortRecent}</option>
      <option value="title">{t.sortTitle}</option>
      <option value="artist">{t.sortArtist}</option>
    </select>
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
            onclick={onSetMusicDir}
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
          onclick={onOpenMusicDir}
        >{t.openMusicFolder}</button>
      {:else}
        <p class="empty-hint">{t.emptyHintAndroid}</p>
      {/if}
    </div>
  {:else}
    <ul class="list">
      {#each rows as row (row.path)}
        {@const open = openPath === row.path && !selectMode}
        {@const position = upNext.get(row.path)}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <li
          class="row"
          class:non-funkot={isNonFunkot(row)}
          class:playing={row.path === playingPath}
          class:open
          onpointerdown={(e) => press.down(e, row.path)}
          onpointermove={press.move}
          onpointerup={press.cancel}
          onpointercancel={press.cancel}
          oncontextmenu={(e) => press.context(e, row.path)}
          onkeydown={(e) => open && closeDetails(e, row.path)}
        >
          {#snippet text()}
            <span class="title">
              <span class="title-text">{row.title}</span>
              {#if row.path === playingPath}<span class="state now">{playingWord}</span>
              {:else if position}<span class="state next">{t.rowUpNext(position)}</span>{/if}
              {#if store.isNewArrival(row.path)}
                <span class="new-badge">NEW</span>
              {/if}
            </span>
            {#if selectMode && (!row.content_hash || store.trackTags?.tracks[row.path]?.content_hash !== row.content_hash)}
              <span class="identity-unavailable">{t.tagIdentityUnavailable}</span>
            {/if}
            <span class="sub">
              <span class="artist">{row.artist || t.noLabel}</span>
              {#if ambiguous.has(row.path)}<span class="file">{store.relName(row.path)}</span>
              {:else}<TagChips state={tagIndex.tracks.get(row.path)?.state ?? null} />{/if}
              <span class="dur">{formatDuration(row.duration_secs)}</span>
            </span>
          {/snippet}
          {#if selectMode}
            <input
              type="checkbox"
              class="pick"
              id={`pick-${row.path}`}
              checked={selected.has(row.path)}
              onchange={() => onToggleRow(row.path)}
              aria-label={t.selectTrackLabel(row.title)}
            />
            <label class="text" for={`pick-${row.path}`}>{@render text()}</label>
          {:else}
            <button type="button" class="text row-select quiet" id={`row-${row.path}`} aria-expanded={open}
              aria-controls={`detail-${row.path}`} aria-label={t.trackDetailsShow(row.title)}
              onclick={() => toggleDetails(row.path)}>{@render text()}</button>
            <FavoriteButton path={row.path} contentHash={row.content_hash} title={row.title} />
            <button
              type="button"
              class="add primary icon-button"
              disabled={addDisabled(row)}
              onclick={() => onAdd(row.path)}
              aria-label={t.playlistAddLabel(row.title, store.destinationLabel || t.playlistNormal)}
            >+</button>
          {/if}
          {#if open}
            {@const verdict = shownVerdict(row)}
            {@const tagReady = !!row.content_hash && store.trackTags?.tracks[row.path]?.content_hash === row.content_hash}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div class="detail" id={`detail-${row.path}`} role="group" aria-label={row.title}
              onpointerdown={(e) => e.stopPropagation()} oncontextmenu={(e) => e.stopPropagation()}>
              <p class="full-title">{row.title}</p>
              <p class="full-artist">{row.artist || t.noLabel}</p>
              <dl>
                <dt>{t.trackLength}</dt><dd>{formatDuration(row.duration_secs)}</dd>
                <dt>{t.trackFile}</dt><dd class="path">{store.relName(row.path)}</dd>
                {#if tagValues(row.path).length}<dt>{t.trackTags}</dt><dd>{tagValues(row.path).join(", ")}</dd>{/if}
              </dl>
              <div class="detail-actions">
                <button type="button" disabled={!tagReady}
                  title={tagReady ? undefined : t.tagIdentityUnavailable}
                  onclick={(e) => openTagEditor([row], row.title || store.relName(row.path), e.currentTarget)}>{t.tagEdit}</button>
                <span class="verdict" role="radiogroup" aria-label={t.labelMenuLabel}>
                  <button type="button" role="radio" aria-checked={verdict === true} disabled={detailBusy} onclick={() => setVerdict(row, true)}>{t.funkot}</button>
                  <button type="button" role="radio" aria-checked={verdict === false} disabled={detailBusy} onclick={() => setVerdict(row, false)}>{t.notFunkot}</button>
                </span>
                <button type="button" class="quiet close" onclick={() => { openPath = null; document.getElementById(`row-${row.path}`)?.focus(); }}>{t.trackDetailsClose}</button>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if menu}
    <TrackMenu path={menu.path} at={menu.at} onclose={() => (menu = null)} />
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
    gap: var(--space-sm);
    padding: var(--space-sm) 0;
    background: var(--color-bg);
  }
  .secondary { display: flex; gap: var(--space-sm); }
  .toolbar :global(.tag-filter) { order: 5; }
  .toolbar :global(.bar) { order: 6; }
  .dest { display: none; flex: 0 1 9rem; min-width: 0; }
  .dest :global(.compact) { max-width: 100%; }
  .dest :global(.destination) { display: none; }
  .dest :global(.choose)::before { content: "+ → "; color: var(--color-text-dim); }

  @container shell not (min-width: 48rem) {
    .heading { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    .dest { display: block; }
    .secondary { display: none; order: 4; flex-basis: 100%; }
    .toolbar:has(:global(.tag-filter)) .secondary { display: flex; }
    .toolbar:has(.secondary.on) :global(.toggle) { outline: 2px solid var(--color-accent-text); outline-offset: -2px; }
  }

  .pick {
    flex: 0 0 auto;
    width: 1.2rem;
    height: 1.2rem;
    margin: 0;
    accent-color: var(--color-accent-bg);
  }

  .search {
    flex: 1 1 5rem;
    min-width: 0;
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
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-md);
    min-height: var(--row-min);
    box-sizing: border-box;
    padding: 1px 0;
    border-bottom: 1px solid var(--color-border);
    user-select: none;
    -webkit-user-select: none;
  }

  .row.non-funkot {
    color: var(--color-text-dim);
  }

  .text {
    min-width: 0;
    flex: 1;
    align-self: stretch;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  /* The row text is the way into the row's details: a plain surface until pointed at. */
  button.text {
    padding: 0;
    border: 0;
    border-radius: 0;
    line-height: 1.25;
    color: inherit;
    text-align: start;
    overflow-wrap: normal;
    cursor: pointer;
  }
  button.text:hover:not(:disabled) { background: var(--color-hover-bg); }
  button.text:active:not(:disabled) { transform: none; }
  button.text:focus-visible { outline-offset: -2px; }
  label.text { cursor: pointer; }

  .state {
    flex: 0 0 auto;
    font-size: var(--font-size-sm);
    line-height: 1.2;
    white-space: nowrap;
  }
  .state.now { color: var(--color-status-playing); font-weight: 600; }
  .state.now::before { content: "▶ "; }
  .state.next { color: var(--color-text-dim); }
  .row.playing { box-shadow: inset 3px 0 0 var(--color-status-playing); padding-left: var(--space-sm); }

  .file {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 55%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row.open { background: var(--color-panel-bg); }
  .detail {
    flex: 1 0 100%;
    box-sizing: border-box;
    padding: var(--space-sm) var(--space-md) var(--space-md);
    border-top: 1px solid var(--color-border);
    user-select: text;
    -webkit-user-select: text;
  }
  .full-title { margin: 0; font-size: var(--font-size-lg); font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
  .full-artist { margin: 0 0 var(--space-sm); color: var(--color-text-dim); overflow-wrap: anywhere; }
  dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--space-xs) var(--space-md);
    margin: 0 0 var(--space-md);
    font-size: var(--font-size-sm);
  }
  dt { color: var(--color-text-dim); }
  dd { margin: 0; overflow-wrap: anywhere; }
  dd.path { font-variant-numeric: tabular-nums; }
  .detail-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-sm); }
  .verdict { display: inline-flex; }
  .verdict button:first-child { border-start-end-radius: 0; border-end-end-radius: 0; }
  .verdict button:last-child { border-start-start-radius: 0; border-end-start-radius: 0; border-inline-start-width: 0; }
  .verdict button[aria-checked="true"] { background: var(--color-accent-bg); color: var(--color-accent-text); }
  .detail-actions .close { margin-inline-start: auto; }

  .title {
    display: flex;
    font-weight: 500;
    align-items: center;
    gap: var(--space-sm);
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
    line-height: 1.25;
  }
  .sub :global(.tag-summary) { margin: 0; flex: 0 1 auto; min-width: 0; max-width: 55%; }

  .artist {
    min-width: 0;
    flex: 1 1 45%;
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
    flex: 0 0 auto;
  }

  .add:disabled {
    background: var(--color-transport-disabled-bg);
    color: var(--color-transport-disabled-text);
  }

</style>
