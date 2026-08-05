<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { toast } from "../lib/toast.svelte";

  // Per-button busy, not a whole-row lock: tapping ↑ must not freeze ↓/✕
  // (legacy `withBusy` disabled only the tapped button).
  let busy = $state<Record<string, boolean>>({});

  let reserved = $derived(store.queue?.reserved ?? null);
  let pending = $derived(store.queue?.pending ?? []);
  let reservedSwappable = $derived(store.queue?.reserved_swappable ?? false);
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
    return `切替まで ${m}:${s.toString().padStart(2, "0")}`;
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

  function toastForError(code: string): string {
    switch (code) {
      case "too_late":
        return "もう切り替えに間に合いません";
      case "stale":
        return "キューが更新されました";
      case "auditioning":
        return "試聴中は変更できません";
      default:
        return "キューを更新できませんでした";
    }
  }

  function onUp(index: number) {
    void withBusy(`up:${index}`, async () => {
      const err = await store.doReorder(index, index - 1, items[index]);
      if (err) toast.notify(toastForError(err));
    });
  }

  function onDown(index: number) {
    void withBusy(`down:${index}`, async () => {
      const err = await store.doReorder(index, index + 1, items[index]);
      if (err) toast.notify(toastForError(err));
    });
  }

  function onDel(index: number) {
    void withBusy(`del:${index}`, async () => {
      const err = await store.doDequeue(index, items[index]);
      if (err) toast.notify(toastForError(err));
    });
  }
</script>

<section class="queue">
  <h2 class="heading">次に再生</h2>

  {#if isEmpty}
    <!-- An empty queue is not an empty playlist: DrainPolicy falls back to
         walking the music folder, so we keep the section visible and say so
         rather than vanishing like legacy/index.html did. -->
    <p class="empty">キューは空 — 自動選曲で継続</p>
  {:else}
    <ul class="list">
      {#each items as path, index (path + ":" + index)}
        <li class="row" class:reserved={reserved !== null && index === 0}>
          <div class="meta">
            <div class="text">
              <div class="title">{store.titleForPath(path)}</div>
              <div class="artist">{store.artistForPath(path)}</div>
            </div>
          </div>
          <div class="trailing">
            {#if reserved !== null && index === 0}
              <!-- Reserved = already handed to the engine to play next.
                   Still gets the same ↑↓✕ as every other row
                   (src-tauri/src/queue.rs `edit_displayed`) — only the badge
                   is special, and only the buttons that would touch this
                   slot get disabled once it is too late to swap. -->
              <span class="badge">
                {reservedSwappable && transitionInSecs !== null
                  ? transitionBadge(transitionInSecs)
                  : "準備済み"}
              </span>
            {/if}
            <div class="acts">
              <button
                type="button"
                class="mini"
                disabled={index === 0 || reservedBlocksMove(index, index - 1) || !!busy[`up:${index}`]}
                onclick={() => onUp(index)}
                aria-label="上へ"
              >↑</button>
              <button
                type="button"
                class="mini"
                disabled={index === items.length - 1 || reservedBlocksMove(index, index + 1) || !!busy[`down:${index}`]}
                onclick={() => onDown(index)}
                aria-label="下へ"
              >↓</button>
              <button
                type="button"
                class="mini"
                disabled={reservedBlocksRemove(index) || !!busy[`del:${index}`]}
                onclick={() => onDel(index)}
                aria-label="削除"
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

  .title {
    font-size: var(--font-size-md);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
