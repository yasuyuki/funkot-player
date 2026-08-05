<script lang="ts">
  import { store } from "../lib/state.svelte";

  // Per-button busy, not a whole-row lock: tapping ↑ must not freeze ↓/✕
  // (legacy `withBusy` disabled only the tapped button).
  let busy = $state<Record<string, boolean>>({});

  let reserved = $derived(store.queue?.reserved ?? null);
  let pending = $derived(store.queue?.pending ?? []);
  let isEmpty = $derived(reserved === null && pending.length === 0);

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
    void withBusy(`up:${index}`, () => store.doReorder(index, index - 1));
  }

  function onDown(index: number) {
    void withBusy(`down:${index}`, () => store.doReorder(index, index + 1));
  }

  function onDel(index: number) {
    void withBusy(`del:${index}`, () => store.doDequeue(index));
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
      {#if reserved !== null}
        <!-- Reserved = already handed to the engine; the host cannot take it
             back (src-tauri/src/queue.rs). No ↑↓✕ — label is 準備済み, not
             the old English "reserved". -->
        <li class="row reserved">
          <div class="meta">
            <span class="play-mark" aria-hidden="true">▶</span>
            <div class="text">
              <div class="title">{store.titleForPath(reserved)}</div>
              <div class="artist">{store.artistForPath(reserved)}</div>
            </div>
          </div>
          <span class="badge">準備済み</span>
        </li>
      {/if}

      {#each pending as path, index (path + ":" + index)}
        <li class="row">
          <div class="meta">
            <div class="text">
              <div class="title">{store.titleForPath(path)}</div>
              <div class="artist">{store.artistForPath(path)}</div>
            </div>
          </div>
          <div class="acts">
            <button
              type="button"
              class="mini"
              disabled={index === 0 || !!busy[`up:${index}`]}
              onclick={() => onUp(index)}
              aria-label="上へ"
            >↑</button>
            <button
              type="button"
              class="mini"
              disabled={index === pending.length - 1 || !!busy[`down:${index}`]}
              onclick={() => onDown(index)}
              aria-label="下へ"
            >↓</button>
            <button
              type="button"
              class="mini"
              disabled={!!busy[`del:${index}`]}
              onclick={() => onDel(index)}
              aria-label="削除"
            >✕</button>
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

  .play-mark {
    color: var(--color-status-playing);
    flex: 0 0 auto;
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
