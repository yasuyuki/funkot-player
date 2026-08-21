<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { toast } from "../lib/toast.svelte";
  import { ui } from "../lib/ui.svelte";

  // See Transport.svelte's comment on why this exists: every command
  // round-trips through the host, so a second tap before the first reply
  // lands must not double-fire.
  let busy = $state(false);

  let transition = $derived(store.player?.last_transition ?? null);
  let auditioning = $derived(store.player?.auditioning ?? false);

  // Mirrors legacy/index.html's `flagEnabled = !!state.last_transition &&
  // !auditionActive`. Deliberately *not* also gated on "did the most recent
  // transition happen automatically": `NowTracker::on_transition_ended`
  // (src-tauri/src/lib.rs) only ever updates `last_transition` for automatic
  // transitions, so right after a user `skip`, this still points at
  // whichever automatic transition happened before the skip -- and "the mix
  // was bad, so I skipped past it" is a primary way this button gets used.
  // What keeps that safe is not disabling the button but always showing the
  // exact pair below that would be recorded, so a stale-looking pair after a
  // skip reads as "this is what would be flagged", not as an error.
  let flagEnabled = $derived(transition !== null && !auditioning);

  let fromTitle = $derived(transition ? store.titleForPath(transition.from) : "");
  let toTitle = $derived(transition ? store.titleForPath(transition.to) : "");

  function formatAgo(secondsAgo: number): string {
    const s = Math.max(0, Math.floor(secondsAgo));
    if (s < 60) return `${s}秒前`;
    return `${Math.floor(s / 60)}分前`;
  }

  let agoLabel = $derived(transition ? formatAgo(transition.seconds_ago) : "");

  // Non-null only when there is no pair to show; keeps the markup below to a
  // single branch instead of juggling three independent conditions.
  let placeholder = $derived(
    auditioning ? "試聴中" : transition === null ? "まだつなぎがありません" : null,
  );

  async function onFlagClick() {
    if (busy || !flagEnabled) return;
    busy = true;
    try {
      const result = await store.doFlagLastTransition();
      if (result) {
        // Toast text comes from the `FlagResult` the command returned
        // (server-resolved titles for the *flagged* pair), not from
        // `fromTitle`/`toTitle` above -- same as legacy's `showFlagToast`,
        // so the toast can never say something different from what was
        // actually written to flags.json.
        toast.show(`${result.from_title} → ${result.to_title} を記録`, () =>
          store.doUndoLastFlag(),
        );
      }
    } finally {
      busy = false;
    }
  }
</script>

<div class="strip">
  <!-- The elapsed time sits on the label row, not with the titles: real
       titles are long enough to fill a line on their own, and giving them
       the full width is what makes the flagged pair readable. -->
  <div class="label">
    <span>直前の自動つなぎ</span>
    {#if agoLabel}<span class="ago">{agoLabel}</span>{/if}
  </div>
  <!-- One title per line, each clipped to its own line. When a pair is
       shown, two lines' worth of height is reserved so the second title
       does not jump the flag button down after a poll cycle (same reason
       as NowCard's title-block). Placeholder states use one line only. -->
  <div class="body" class:one-line={placeholder !== null}>
    {#if placeholder !== null}
      <span class="placeholder">{placeholder}</span>
    {:else if transition}
      <div class="line">{fromTitle}</div>
      <div class="line">→ {toTitle}</div>
    {/if}
  </div>
  <div class="flag-row">
    <button type="button" class="flag" disabled={!flagEnabled || busy} onclick={onFlagClick}>
      ⚑ このつなぎは不適切
    </button>
    <button
      type="button"
      class="mode-toggle"
      aria-label={ui.mode === "play" ? "編集モードへ" : "再生モードへ"}
      onclick={() => ui.setMode(ui.mode === "play" ? "edit" : "play")}
    >{ui.mode === "play" ? "編集" : "再生"}</button>
  </div>
</div>

<style>
  /* No margin-bottom: App.svelte's .playback-blocks owns the gap between
     this block and Transport, because either one can come second. */
  .label {
    display: flex;
    justify-content: space-between;
    gap: var(--space-sm);
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
    margin-bottom: var(--space-xs);
  }
  .body {
    min-height: calc(var(--font-size-md) * 1.5 * 2);
    font-size: var(--font-size-md);
    color: var(--color-text);
    margin-bottom: var(--space-xs);
  }
  .body.one-line {
    min-height: calc(var(--font-size-md) * 1.5);
  }
  .line {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .placeholder {
    color: var(--color-text-dim);
  }
  .ago {
    flex: none;
  }
  .flag-row {
    display: flex;
    gap: var(--space-xs);
  }
  /* Amber outline, not fill: see tokens.css's `--color-flag-amber` comment
     -- a filled amber would collide with Transport's paused/resume colour.
     No `transition`, same tap-must-be-instant reason as every button here. */
  .flag {
    flex: 2;
    width: auto;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: var(--font-size-md);
    padding: var(--space-md) var(--space-lg);
    min-height: var(--transport-btn-min-height);
    background: transparent;
    color: var(--color-flag-amber);
    border: 1px solid var(--color-flag-amber);
  }
  .mode-toggle {
    flex: 1;
    width: auto;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: var(--font-size-md);
    padding: var(--space-md) var(--space-lg);
    min-height: var(--transport-btn-min-height);
    background: var(--color-tab-bg);
    color: var(--color-tab-text);
  }
</style>
