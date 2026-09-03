<script lang="ts">
  import { openMusicDir } from "../lib/tauri";
  import { store } from "../lib/state.svelte";
  import { toast } from "../lib/toast.svelte";
  import { ui } from "../lib/ui.svelte";
  import { i18n } from "../lib/i18n.svelte";
  import { phaseLabel as phaseText } from "../lib/messages";

  let t = $derived(i18n.t);

  function formatTime(secs: number | null): string {
    if (secs === null || !Number.isFinite(secs)) return "--:--";
    const total = Math.max(0, Math.floor(secs));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  let phase = $derived(store.player?.phase ?? "idle");
  let phaseLabel = $derived(phaseText(t, phase));
  let elapsed = $derived(store.elapsed);
  let duration = $derived(store.player?.duration_secs ?? null);
  let progressPct = $derived(
    duration !== null && duration > 0 && elapsed !== null
      ? Math.min(100, Math.max(0, (elapsed / duration) * 100))
      : 0,
  );

  let nowPath = $derived(store.player?.now_playing ?? null);
  let nowRow = $derived(nowPath ? store.trackForPath(nowPath) : undefined);
  let shownFunkot = $derived(
    nowRow ? (nowRow.label ?? nowRow.is_funkot) : null,
  );
  let labelProgress = $derived(store.labelProgress);

  // `lastError` is included, not just `phase === "failed"`, because the
  // always-on `#log` from legacy/index.html is gone (behind the ⋮ menu
  // now): without this an `invoke` failure that does not also flip the
  // phase (e.g. a failed `skip_next` while still playing) would be
  // completely invisible.
  let showLogLink = $derived(phase === "failed" || store.lastError !== null);
  // Store certification path: when Start fails for an empty library, offer
  // the same Music-folder opener as Library / OverflowMenu next to the log
  // link. The substring has to stay in step with `ensure_tracks_available`
  // (src-tauri/src/lib.rs), which spells the error `need >= 1 track in <dir>,
  // found 0`.
  let showOpenMusic = $derived(
    store.lastError !== null && store.lastError.includes("need >= 1 track"),
  );
  let openMusicBusy = $state(false);
  let labelBusy = $state(false);

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

  async function onToggleLabel() {
    if (labelBusy || !nowPath || !nowRow || shownFunkot === null) return;
    labelBusy = true;
    const prevLabel = nowRow.label;
    const next = !shownFunkot;
    try {
      const updated = await store.doSetLabel(nowPath, next);
      if (!updated) return;
      toast.show(next ? t.labeledFunkot : t.labeledNotFunkot, async () => {
        const restored = await store.doSetLabel(nowPath!, prevLabel);
        return restored !== null;
      });
    } finally {
      labelBusy = false;
    }
  }
</script>

<div class="now-card">
  <div class="badge-row">
    <span class="badge" class:idle={phase === "idle"} class:starting={phase === "starting"}
      class:playing={phase === "playing"} class:paused={phase === "paused"}
      class:stalled={phase === "stalled"} class:failed={phase === "failed"}
      class:disconnected={phase === "disconnected"}>
      {phaseLabel}
    </span>
    {#if nowRow && shownFunkot !== null}
      <button
        type="button"
        class="label-toggle"
        disabled={labelBusy}
        onclick={onToggleLabel}
      >{shownFunkot ? t.funkot : t.notFunkot}</button>
    {/if}
    <!-- n / total is the folder-scan position: a meter for the labelling
         pass, not for listening. Off the play screen unless labelling mode is
         on, where it is the only way to tell how far through the folder the
         session has got. -->
    {#if store.labelingMode}
      <span class="progress">{labelProgress.current} / {labelProgress.total}</span>
    {/if}
  </div>

  <!-- Reserved height on the title/artist block: the title/artist arrive a
       poll cycle after the phase does (they come from `now_playing` + a
       library lookup), and without a fixed minimum height here the
       Transport buttons below jump down the moment they land -- exactly
       the #now behaviour legacy/index.html reserved height for. -->
  <div class="title-block">
    <div class="title">{store.nowTitle ?? ""}</div>
    <div class="artist">{store.nowArtist}</div>
  </div>

  <div class="time-row">
    <span class="time">{formatTime(elapsed)}</span>
    <div class="bar"><div class="bar-fill" style={`width: ${progressPct}%`}></div></div>
    <span class="time">{formatTime(duration)}</span>
  </div>

  {#if showLogLink || showOpenMusic}
    <div class="error-actions">
      {#if showLogLink}
        <button type="button" class="log-link" onclick={() => (ui.logOpen = true)}>
          {t.showLog}
        </button>
      {/if}
      {#if showOpenMusic}
        <button
          type="button"
          class="log-link"
          disabled={openMusicBusy}
          onclick={onOpenMusicDir}
        >{t.openMusicFolder}</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .now-card {
    margin-bottom: var(--space-md);
  }

  .badge-row {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-sm);
    margin-bottom: var(--space-sm);
  }

  .badge {
    display: inline-block;
    font-size: var(--font-size-sm);
  }
  .badge.idle { color: var(--color-status-idle); }
  .badge.starting { color: var(--color-status-starting); }
  .badge.playing { color: var(--color-status-playing); }
  .badge.paused { color: var(--color-status-paused); }
  .badge.stalled { color: var(--color-status-stalled); }
  .badge.failed { color: var(--color-status-failed); }
  .badge.disconnected { color: var(--color-status-disconnected); }

  .label-toggle {
    width: auto;
    font-size: var(--font-size-sm);
    padding: 0;
    margin: 0;
    background: transparent;
    color: var(--color-link);
    text-decoration: underline;
    border-radius: 0;
  }

  .progress {
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
    font-variant-numeric: tabular-nums;
    margin-left: auto;
  }

  .title-block {
    /* Two lines' worth of reserved height -- see the comment in the markup. */
    min-height: calc(var(--font-size-md) * 1.5 + var(--font-size-sm) * 1.5);
    margin-bottom: var(--space-sm);
  }
  .title {
    font-size: var(--font-size-md);
    color: var(--color-text);
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

  .time-row {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    min-height: calc(var(--font-size-sm) * 1.5);
  }
  .time {
    font-size: var(--font-size-sm);
    color: var(--color-text-dim);
    flex: none;
  }
  .bar {
    flex: 1;
    height: 3px;
    background: var(--color-border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    background: var(--color-status-playing);
    /* No transition: this is driven by a 250ms interpolation tick already,
       animating on top of that would make the bar visibly lag itself. */
  }

  .error-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm) var(--space-md);
    margin-top: var(--space-sm);
  }

  /* Overrides tokens.css's default `button` (full width, large padding):
     this is an inline text link under the card, not a standalone control. */
  .log-link {
    width: auto;
    font-size: var(--font-size-sm);
    padding: 0;
    margin: 0;
    background: transparent;
    color: var(--color-link);
    text-decoration: underline;
    border-radius: 0;
  }
</style>
