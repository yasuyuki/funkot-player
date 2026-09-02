<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { toast } from "../lib/toast.svelte";
  import { i18n } from "../lib/i18n.svelte";
  import { queueErrorMessage } from "../lib/messages";

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
</script>

<section class="queue">
  <h2 class="heading">{t.queueHeading}</h2>

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
</style>
