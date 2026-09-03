<script lang="ts">
  // The two questions play history can answer, on one pane.
  //
  // 「曲ごと」 comes from `history.json` — how often, and when last — so it is
  // populated from the first run of this build, including plays from before
  // the chronological log existed. 「再生順」 comes from `play-log.jsonl`,
  // which starts empty: an aggregate cannot be turned back into a sequence,
  // which is the whole reason the log was added.
  import { store } from "../lib/state.svelte";
  import { i18n } from "../lib/i18n.svelte";
  import { enqueueManyMessage } from "../lib/messages";
  import { toast } from "../lib/toast.svelte";
  import {
    calendarDaysAgo,
    groupPlaysByDay,
    playedOnly,
    selectablePaths,
  } from "../lib/play-history";
  import {
    addAll,
    clearSelection,
    selectAllState,
    selectedInOrder,
    toggleSelected,
  } from "../lib/selection";
  import SelectionBar from "./SelectionBar.svelte";

  let t = $derived(i18n.t);

  let view = $state<"tracks" | "log">("tracks");
  let selectMode = $state(false);
  /// Keyed by path, like the library's: what gets queued is a path, and the
  /// log lists the same track once per play.
  let selected = $state<Set<string>>(new Set());
  let addManyBusy = $state(false);

  /// Pulled on `history_revision` rather than on the tab being showing: in the
  /// three-column band this pane is visible while `playSub` is "library", so a
  /// tab-gated load would leave it permanently empty.
  ///
  /// This runs on every poll, because the poll reassigns `player` wholesale.
  /// `loadPlayHistory` is what turns that into one invoke per track change.
  $effect(() => {
    void store.loadPlayHistory(store.player?.history_revision ?? null);
  });

  let history = $derived(store.playHistory);
  let tracks = $derived(playedOnly(history?.tracks ?? []));
  let days = $derived(groupPlaysByDay(history?.log ?? []));

  /// Ticks only when the pane reloads, which is enough: the boundary these
  /// dates sit on moves once a day, and a reload happens every track.
  let now = $derived.by(() => {
    void history;
    return Date.now();
  });

  let addOrder = $derived(
    view === "tracks" ? selectablePaths(tracks) : selectablePaths(history?.log ?? []),
  );
  let selectedCount = $derived(selectedInOrder(selected, addOrder).length);
  let allState = $derived(selectAllState(selected, addOrder));

  function formatTime(atMs: number): string {
    return new Date(atMs).toLocaleTimeString(i18n.locale, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  /// Today and yesterday are named; anything older gets its date, which is
  /// what the reader would have to work out themselves otherwise.
  function formatPlayedAt(atMs: number): string {
    const time = formatTime(atMs);
    const days = calendarDaysAgo(atMs, now);
    if (days === 0) return t.playedToday(time);
    if (days === 1) return t.playedYesterday(time);
    return `${new Date(atMs).toLocaleDateString(i18n.locale)} ${time}`;
  }

  function formatDayHeading(atMs: number): string {
    const days = calendarDaysAgo(atMs, now);
    if (days === 0) return t.playedToday("").trim();
    if (days === 1) return t.playedYesterday("").trim();
    return new Date(atMs).toLocaleDateString(i18n.locale);
  }

  function setView(next: "tracks" | "log") {
    if (view === next) return;
    view = next;
    // The two views list different things, so a selection made in one would
    // silently include rows the other does not show.
    selected = clearSelection();
  }

  function toggleSelectMode() {
    selectMode = !selectMode;
    if (!selectMode) selected = clearSelection();
  }

  function titleOf(row: { title: string; missing: boolean }): string {
    return row.missing ? t.missingTrack : row.title;
  }

  async function onAddSelected() {
    if (addManyBusy) return;
    const paths = selectedInOrder(selected, addOrder);
    if (paths.length === 0) return;
    addManyBusy = true;
    try {
      const result = await store.doEnqueueMany(paths);
      if (result) {
        toast.notify(enqueueManyMessage(t, result));
        selected = clearSelection();
      }
    } finally {
      addManyBusy = false;
    }
  }
</script>

<section class="history">
  <h2 class="heading">{t.historyHeading}</h2>

  <div class="toolbar">
    <div class="views" role="tablist" aria-label={t.historyHeading}>
      <button
        type="button"
        class="view"
        class:active={view === "tracks"}
        role="tab"
        aria-selected={view === "tracks"}
        onclick={() => setView("tracks")}
      >{t.historyByTrack}</button>
      <button
        type="button"
        class="view"
        class:active={view === "log"}
        role="tab"
        aria-selected={view === "log"}
        onclick={() => setView("log")}
      >{t.historyByTime}</button>
    </div>
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
        count={selectedCount}
        {allState}
        busy={addManyBusy}
        onSelectAll={() => (selected = addAll(selected, addOrder))}
        onClear={() => (selected = clearSelection())}
        onAdd={onAddSelected}
      />
    {/if}
  </div>

  {#if view === "tracks"}
    {#if tracks.length === 0}
      <p class="empty">{t.historyEmpty}</p>
    {:else}
      <ul class="list">
        {#each tracks as row (row.track_hash)}
          <li class="row" class:missing={row.missing}>
            {#if selectMode}
              <input
                type="checkbox"
                class="pick"
                checked={row.path !== null && selected.has(row.path)}
                disabled={row.missing || row.path === null}
                onchange={() => row.path && (selected = toggleSelected(selected, row.path))}
                aria-label={t.selectTrackLabel(titleOf(row))}
              />
            {/if}
            <div class="text">
              <div class="title">{titleOf(row)}</div>
              <div class="sub">
                <span class="artist">{row.artist || t.noLabel}</span>
                <span class="when">{formatPlayedAt(row.last_played_ms)}</span>
              </div>
            </div>
            <span class="count">{t.playCount(row.count)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {:else if days.length === 0}
    <p class="empty">{t.historyLogEmpty}</p>
  {:else}
    <!-- Grouped by day so a long session does not repeat the same date on
         every row; the time is what varies within one. -->
    {#each days as day (day.key)}
      <h3 class="day">{formatDayHeading(day.rows[0].at_ms)}</h3>
      <ul class="list">
        {#each day.rows as row (`${row.at_ms}:${row.track_hash}`)}
          <li class="row" class:missing={row.missing}>
            {#if selectMode}
              <input
                type="checkbox"
                class="pick"
                checked={row.path !== null && selected.has(row.path)}
                disabled={row.missing || row.path === null}
                onchange={() => row.path && (selected = toggleSelected(selected, row.path))}
                aria-label={t.selectTrackLabel(titleOf(row))}
              />
            {/if}
            <span class="at">{formatTime(row.at_ms)}</span>
            <div class="text">
              <div class="title">{titleOf(row)}</div>
              <div class="sub">
                <span class="artist">{row.artist || t.noLabel}</span>
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {/each}
  {/if}
</section>

<style>
  .history {
    margin-top: var(--space-xl);
  }

  .heading {
    margin: 0 0 var(--space-md);
    font-size: var(--font-size-md);
    font-weight: 600;
    color: var(--color-text);
  }

  /* Same sticky offset as the library's toolbar, for the same reason: `top: 0`
     would park under the Android status bar once it sticks. */
  .toolbar {
    position: sticky;
    top: calc(var(--space-xl) + env(safe-area-inset-top, 3rem));
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
    padding: var(--space-sm) 0;
    background: var(--color-bg);
  }

  .views {
    display: flex;
    flex: 1;
    min-width: 0;
    gap: var(--space-xs);
  }

  .view,
  .filter {
    width: auto;
    font-size: var(--font-size-sm);
    padding: var(--space-sm) var(--space-md);
    background: var(--color-tab-bg);
    color: var(--color-tab-text);
  }

  .view {
    flex: 1;
  }

  .view.active {
    background: var(--color-tab-active-bg);
    color: var(--color-tab-active-text);
  }

  .filter {
    flex: 0 0 auto;
    background: var(--color-transport-secondary-bg);
    color: var(--color-transport-secondary-text);
  }

  .filter.on {
    outline: 2px solid var(--color-accent-text);
    outline-offset: -2px;
  }

  .day {
    margin: var(--space-md) 0 var(--space-xs);
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--color-text-dim);
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  /* Same fixed row height as the library, so a virtual list stays possible. */
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-md);
    min-height: var(--library-row-height);
    border-bottom: 1px solid var(--color-border);
  }

  .row.missing .title {
    color: var(--color-text-dim);
    font-style: italic;
  }

  .pick {
    flex: 0 0 auto;
    width: 1.2rem;
    height: 1.2rem;
    margin: 0;
    accent-color: var(--color-accent-bg);
  }

  /* Tabular so the times line up down the column. */
  .at {
    flex: 0 0 auto;
    font-size: var(--font-size-sm);
    font-variant-numeric: tabular-nums;
    color: var(--color-text-dim);
  }

  /* `min-width: 0` is what lets the ellipsis below actually apply. */
  .text {
    flex: 1;
    min-width: 0;
  }

  .title,
  .artist {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .title {
    font-size: var(--font-size-md);
    color: var(--color-text);
  }

  .sub {
    display: flex;
    gap: var(--space-md);
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
  }

  .artist {
    flex: 1;
    min-width: 0;
  }

  .when,
  .count {
    flex: 0 0 auto;
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
  }

  .empty {
    margin: 0;
    padding: var(--space-md);
    color: var(--color-text-dim);
    font-size: var(--font-size-sm);
    line-height: 1.4;
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-sm);
  }
</style>
