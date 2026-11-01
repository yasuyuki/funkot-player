<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { i18n } from "../lib/i18n.svelte";

  let t = $derived(i18n.t);

  let transition = $derived(store.player?.last_transition ?? null);
  let auditioning = $derived(store.player?.auditioning ?? false);

  let fromTitle = $derived(transition ? store.titleForPath(transition.from) : "");
  let toTitle = $derived(transition ? store.titleForPath(transition.to) : "");

  function formatAgo(secondsAgo: number): string {
    const s = Math.max(0, Math.floor(secondsAgo));
    if (s < 60) return t.secondsAgo(s);
    return t.minutesAgo(Math.floor(s / 60));
  }

  let placeholder = $derived(
    auditioning ? t.auditioningShort : transition === null ? t.noTransitionYet : null,
  );

  let meta = $derived(
    placeholder === null && transition
      ? `${t.lastAutoTransition} · ${formatAgo(transition.seconds_ago)}`
      : t.lastAutoTransition,
  );
</script>

<div class="strip">
  <span class="meta">{meta}</span>
  {#if placeholder !== null}
    <span class="pair placeholder">{placeholder}</span>
  {:else if transition}
    <span class="pair">{fromTitle} → {toTitle}</span>
  {/if}
</div>

<style>
  .strip {
    display: flex;
    align-items: baseline;
    gap: var(--space-sm);
    min-height: calc(var(--font-size-md) * 1.5);
  }
  .meta {
    flex: none;
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
  }
  .pair {
    flex: 1;
    min-width: 0;
    font-size: var(--font-size-md);
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .placeholder {
    color: var(--color-text-dim);
  }
</style>
