<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { toast } from "../lib/toast.svelte";
  import { primaryMode as resolvePrimaryMode, canSkipNext } from "../lib/transportMode";
  import { i18n } from "../lib/i18n.svelte";

  let t = $derived(i18n.t);

  // Every command round-trips through the host, and `start`/`toggle_pause`
  // touch the filesystem or the audio thread; without a busy guard a second
  // tap before the first reply lands double-fires (the desktop/legacy
  // equivalent was `withBusy`). One flag per button, not one for the row: a
  // tap on the next-track button must not wait on an in-flight start/pause or
  // vice-versa, and flagging is a different command again.
  let primaryBusy = $state(false);
  let nextBusy = $state(false);
  let flagBusy = $state(false);

  let phase = $derived(store.player?.phase ?? "idle");
  let paused = $derived(store.player?.paused ?? false);
  let auditioning = $derived(store.player?.auditioning ?? false);

  // Mapping lives in transportMode.ts (paused flag, not phase alone).
  let mode = $derived(resolvePrimaryMode(phase, paused, auditioning));

  // ⏸ comes out as Android's colour emoji tile (orange, on the green button)
  // while ▶ and ⏭ get the monochrome text glyph. U+FE0E does not override it
  // — tried on the device — so fixing it needs a different glyph or an inline
  // SVG; left for stage 5 rather than spent a build cycle on here.
  let primaryLabel = $derived(
    mode === "pause" ? t.pause : mode === "resume" ? t.resumePlayback : t.start,
  );

  // "idle" only, not "failed" as well: `start()` can only fail after it has
  // already flipped its own `started` latch, so offering the button again
  // would just answer "already started". A failed start needs the app
  // restarted, not another tap, so the button stays off rather than looking
  // like it would retry -- see legacy/index.html's `applyPhase` comment,
  // which this rule is carried over from unchanged.
  let primaryDisabled = $derived(
    mode === "off" ||
      primaryBusy ||
      (mode === "start" && !store.canStart),
  );

  let nextEnabled = $derived(
    canSkipNext(phase, auditioning, store.queue?.reserved_prepared ?? false),
  );
  let nextDisabled = $derived(!nextEnabled || nextBusy);

  // Moved here from TransitionStrip so the three high-frequency taps sit on
  // one row. Mirrors legacy/index.html's `flagEnabled = !!state.last_transition
  // && !auditionActive`. Deliberately *not* also gated on "did the most recent
  // transition happen automatically": `NowTracker::on_transition_ended`
  // (src-tauri/src/lib.rs) only ever updates `last_transition` for automatic
  // transitions, so right after a user `skip`, this still points at whichever
  // automatic transition happened before the skip -- and "the mix was bad, so
  // I skipped past it" is a primary way this button gets used. What keeps that
  // safe is TransitionStrip below still naming the exact pair that would be
  // recorded, so a stale-looking pair after a skip reads as "this is what
  // would be flagged", not as an error.
  let flagEnabled = $derived(
    (store.player?.last_transition ?? null) !== null && !auditioning,
  );

  async function onFlagClick() {
    if (flagBusy || !flagEnabled) return;
    flagBusy = true;
    try {
      const result = await store.doFlagLastTransition();
      if (result) {
        // Toast text comes from the `FlagResult` the command returned
        // (server-resolved titles for the *flagged* pair), not from the pair
        // TransitionStrip is showing -- same as legacy's `showFlagToast`, so
        // the toast can never say something different from what was actually
        // written to flags.json.
        toast.show(t.flagRecorded(result.from_title, result.to_title), () =>
          store.doUndoLastFlag(),
        );
      }
    } finally {
      flagBusy = false;
    }
  }

  async function onPrimaryClick() {
    if (primaryBusy) return;
    primaryBusy = true;
    try {
      if (mode === "start") {
        await store.doStart();
      } else if (mode === "pause" || mode === "resume") {
        await store.doTogglePause();
      }
    } finally {
      primaryBusy = false;
    }
  }

  async function onNextClick() {
    if (nextBusy) return;
    nextBusy = true;
    try {
      await store.doSkipNext();
    } finally {
      nextBusy = false;
    }
  }
</script>

<div class="transport">
  <button
    type="button"
    class="primary"
    class:resume={mode === "resume"}
    disabled={primaryDisabled}
    onclick={onPrimaryClick}
  >
    {primaryLabel}
  </button>
  <button type="button" class="secondary" disabled={nextDisabled} onclick={onNextClick}>
    {t.nextTrack}
  </button>
  <!-- Icon only: the full sentence is the accessible name, and spelling it
       out here would push the two playback buttons off a phone-width row. -->
  <button
    type="button"
    class="flag"
    disabled={!flagEnabled || flagBusy}
    aria-label={t.flagBadTransition}
    title={t.flagBadTransition}
    onclick={onFlagClick}
  >⚑</button>
</div>

<style>
  .transport {
    display: flex;
    flex-direction: row;
    gap: var(--space-md);
    align-items: stretch;
  }

  /* No transition on either button: a tap must show up immediately, not
     after a fade -- see the equivalent comment on the base `button` rule in
     tokens.css, which this deliberately does not override. */
  .primary,
  .secondary,
  .flag {
    /* Override global `button { width: 100% }` so flex: 2/1 can share the row. */
    width: auto;
    padding: var(--space-md) var(--space-lg);
    font-size: var(--font-size-md);
    min-height: var(--transport-btn-min-height);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .primary {
    flex: 2;
    min-width: 0;
    background: var(--color-transport-primary-bg);
    color: var(--color-transport-primary-text);
  }
  .primary.resume {
    background: var(--color-transport-paused-bg);
    color: var(--color-transport-paused-text);
  }
  .secondary {
    flex: 1;
    min-width: 0;
    background: var(--color-transport-secondary-bg);
    color: var(--color-transport-secondary-text);
  }
  /* Amber outline, not fill: see tokens.css's `--color-flag-amber` comment
     -- a filled amber would collide with the paused/resume colour above. */
  .flag {
    flex: 1;
    min-width: 0;
    background: transparent;
    color: var(--color-flag-amber);
    border: 1px solid var(--color-flag-amber);
  }
  /* Not `.flag`: the outline keeps its colour and the global
     `button[disabled]` opacity is what reads as unavailable, the same way it
     did while this button lived in TransitionStrip. */
  .primary:disabled,
  .secondary:disabled {
    background: var(--color-transport-disabled-bg);
    color: var(--color-transport-disabled-text);
  }
</style>
