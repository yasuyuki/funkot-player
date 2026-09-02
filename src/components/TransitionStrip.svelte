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

  // Non-null only when there is no pair to show; keeps the markup below to a
  // single branch instead of juggling three independent conditions.
  let placeholder = $derived(
    auditioning ? t.auditioningShort : transition === null ? t.noTransitionYet : null,
  );

  // The elapsed time belongs to the pair, so it is dropped along with it:
  // "直前の自動つなぎ · 3分前 試聴中" would date a line that is not showing a
  // transition at all.
  let meta = $derived(
    placeholder === null && transition
      ? `${t.lastAutoTransition} · ${formatAgo(transition.seconds_ago)}`
      : t.lastAutoTransition,
  );
</script>

<!-- One line: the label and elapsed time dim in front, then the pair that the
     Transport row's ⚑ would record. This is a read-out, not a control -- the
     flag button that used to sit under it is on the Transport row now, and
     the play/edit switch is in the header. -->
<div class="strip">
  <span class="meta">{meta}</span>
  {#if placeholder !== null}
    <span class="pair placeholder">{placeholder}</span>
  {:else if transition}
    <span class="pair">{fromTitle} → {toTitle}</span>
  {/if}
</div>

<style>
  /* No margin-bottom: App.svelte's .playback-blocks owns the gap between
     this block and Transport, because either one can come second.

     One line's worth of height is reserved even while empty: the pair
     arrives a poll cycle after the phase does, and without this the library
     below jumps up the moment it lands. */
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
  /* The titles take whatever is left and clip; the label in front is short
     and fixed, so the ellipsis always lands on the part that is too long. */
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
