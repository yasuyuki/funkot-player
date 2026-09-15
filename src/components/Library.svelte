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
  import TrackMenu from "./TrackMenu.svelte";
  import { createLongPress, type MenuPoint } from "../lib/track-menu";
  import { tagTargets, tagEditSelection, enqueueSelection } from "../lib/tag-edit";
  import { tagEditorSession } from "../lib/tag-editor.svelte";
  import { buildTagIndex, matchesTagFilter, type TagChoice, type TagFilter as TagFilterState } from "../lib/tag-filter";
  import TagFilter from "./TagFilter.svelte";
  import TagChips from "./TagChips.svelte";

  let t = $derived(i18n.t);

  let query = $state("");
  let sortKey = $state<LibrarySortKey>("recent");
  let newOnly = $state(false);
  let selectedTags = $state<TagChoice[]>([]);
  let tagMode = $state<"all" | "any">("all");
  let yearUnset = $state(false);
  // This index depends on library/snapshot changes, never the search text.
  let tagIndex = $derived(buildTagIndex(store.libraryList, store.trackTags));
  let tagFilter = $derived<TagFilterState>({ keys: selectedTags.map(tag => tag.key), mode: tagMode, yearUnset });
  function chooseTag(tag: TagChoice) {
    if (!selectedTags.some(item => item.key === tag.key)) selectedTags = [...selectedTags, { key: tag.key, kind: tag.kind, value: tag.value }];
  }
  function clearTagFilters() { selectedTags = []; yearUnset = false; }
  let busy = $state<Record<string, boolean>>({});
  /// A mode rather than a permanent checkbox column: on a 412px phone the row
  /// already carries title, artist, duration and the `+` button, and a
  /// checkbox that is there for an occasional action would cost that width
  /// every time the library is browsed.
  let selectMode = $state(false);
  /// Keyed by path. Survives a tab swap for free -- both panes stay mounted
  /// and are only `display:none`'d -- and is dropped when play mode unmounts
  /// them, which is the right moment to forget it.
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

  /// Every selectable row in the pane's current sort, ignoring the search box
  /// and the new-only filter.
  ///
  /// This -- not `rows` -- is the universe the bulk add works over, so typing
  /// in the search box cannot silently make the button add nothing.
  let enqueuePaths = $derived(enqueueSelection(sortLibraryRows(store.libraryList, sortKey), selected, store.allowNonFunkot));

  /// Rows currently on screen: what "select all" acts on. Scoping a bulk
  /// action is what the search box is for; "select all 5,000" is never the
  /// intent.
  // Tag editing is independent of playback eligibility: a non-Funkot row is
  // still visible, selectable, and editable when it has a resolved hash.
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

  async function onAddSelected() {
    if (addManyBusy) return;
    const paths = enqueuePaths;
    if (paths.length === 0) return;
    addManyBusy = true;
    try {
      const result = await store.doEnqueueMany(paths);
      if (result) {
        toast.notify(enqueueManyMessage(t, result));
        // The rows are queued or knowingly refused; leaving forty boxes
        // ticked is worse than re-selecting. The mode stays on.
        selected = clearSelection();
      }
    } finally {
      addManyBusy = false;
    }
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

  /// The gate alone: analysed, effectively non-Funkot, and the setting is off.
  /// Separate from [`addDisabled`] because that also folds in the per-row busy
  /// flag, and a single add in flight must not drop the row out of a bulk
  /// selection.
  function gated(row: TrackRow): boolean {
    return isNonFunkot(row) && !store.allowNonFunkot;
  }

  function addDisabled(row: TrackRow): boolean {
    return !!busy[row.path] || gated(row);
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
    <button
      type="button"
      class="filter"
      class:on={selectMode}
      aria-pressed={selectMode}
      aria-label={t.selectModeLabel}
      onclick={toggleSelectMode}
    >{t.selectMode}</button>
    {#if selectMode}
      <SelectionBar
        totalSelected={selectedCount}
        {enqueueCount}
        {visibleTagCount}
        tagUnavailable={visibleTagCount !== tagSelectedRows.length}
        {allState}
        busy={addManyBusy}
        onSelectAll={() => (selected = addAll(selected, visiblePaths))}
        onClear={() => (selected = clearSelection())}
        onAdd={onAddSelected}
        onEditTags={(event) => openTagEditor(tagSelectedRows, t.tagEditSelected, event.currentTarget as HTMLElement)}
      />
    {/if}
  </div>

  <TagFilter candidates={tagIndex.candidates} selected={selectedTags} mode={tagMode} {yearUnset}
    onchoose={chooseTag} onremove={key => selectedTags = selectedTags.filter(tag => tag.key !== key)}
    onmode={mode => tagMode = mode} onunset={enabled => yearUnset = enabled} onclear={clearTagFilters} />
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
    <!-- Rows grow to fit compact tags and identity status without overlap. -->
    <ul class="list">
      {#each rows as row (row.path)}
        <li
          class="row"
          class:non-funkot={isNonFunkot(row)}
          onpointerdown={(e) => press.down(e, row.path)}
          onpointermove={press.move}
          onpointerup={press.cancel}
          onpointercancel={press.cancel}
          oncontextmenu={(e) => press.context(e, row.path)}
        >
          {#if selectMode}
            <!-- Queue selection remains available; tag eligibility is checked
                 independently against the committed tag snapshot. -->
            <input
              type="checkbox"
              class="pick"
              checked={selected.has(row.path)}
              onchange={() => onToggleRow(row.path)}
              aria-label={t.selectTrackLabel(row.title)}
            />
          {/if}
          <div class="text">
            <div class="title">
              <span class="title-text">{row.title}</span>
              {#if store.isNewArrival(row.path)}
                <span class="new-badge">NEW</span>
              {/if}
            </div>
            {#if selectMode && (!row.content_hash || store.trackTags?.tracks[row.path]?.content_hash !== row.content_hash)}
              <span class="identity-unavailable">{t.tagIdentityUnavailable}</span>
            {/if}
            <div class="sub">
              <span class="artist">{row.artist || t.noLabel}</span>
              <span class="dur">{formatDuration(row.duration_secs)}</span>
            </div>
            <TagChips state={tagIndex.tracks.get(row.path)?.state ?? null} onchoose={chooseTag}
              ondetails={event => openTagEditor([row], row.title, event.currentTarget instanceof HTMLElement ? event.currentTarget : null)} />
          </div>
          {#if !selectMode}
            <!-- Unanalysed tracks can still be enqueued (legacy behaviour). -->
            <button
              type="button"
              class="add"
              disabled={addDisabled(row)}
              onclick={() => onAdd(row.path)}
              aria-label={t.addToQueueLabel(row.title)}
            >+</button>
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
    /* The selection bar is a full-width flex item, so it wraps onto a second
       line here instead of being a second sticky element with its own copy of
       the safe-area calc above. */
    flex-wrap: wrap;
    gap: var(--space-sm);
    padding: var(--space-sm) 0;
    background: var(--color-bg);
  }

  /* Not `width: auto` from the global button rule -- a checkbox is not a
     button -- but it does need a fixed footprint so rows stay aligned. */
  .pick {
    flex: 0 0 auto;
    width: 1.2rem;
    height: 1.2rem;
    margin: 0;
    accent-color: var(--color-accent-bg);
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
  .identity-unavailable { font-size: var(--font-size-sm); color: var(--color-text-dim); overflow-wrap: anywhere; }

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
    min-height: var(--library-row-height);
    padding: var(--space-sm) 0;
    border-bottom: 1px solid var(--color-border);
    user-select: none;
    -webkit-user-select: none;
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
