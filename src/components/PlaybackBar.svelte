<script lang="ts">
  import { openMusicDir } from "../lib/tauri";
  import { store } from "../lib/state.svelte";
  import { toast } from "../lib/toast.svelte";
  import { ui } from "../lib/ui.svelte";
  import { i18n } from "../lib/i18n.svelte";
  import { phaseLabel as phaseText } from "../lib/messages";
  import { primaryMode as resolvePrimaryMode, canSkipNext } from "../lib/transportMode";
  import FavoriteButton from "./FavoriteButton.svelte";

  let t = $derived(i18n.t);

  function formatTime(secs: number | null): string {
    if (secs === null || !Number.isFinite(secs)) return "--:--";
    const total = Math.max(0, Math.floor(secs));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }
  function formatAgo(secondsAgo: number): string {
    const s = Math.max(0, Math.floor(secondsAgo));
    return s < 60 ? t.secondsAgo(s) : t.minutesAgo(Math.floor(s / 60));
  }

  let phase = $derived(store.player?.phase ?? "idle");
  let paused = $derived(store.player?.paused ?? false);
  let auditioning = $derived(store.player?.auditioning ?? false);
  let elapsed = $derived(store.elapsed);
  let duration = $derived(store.player?.duration_secs ?? null);
  let progressPct = $derived(
    duration !== null && duration > 0 && elapsed !== null ? Math.min(100, Math.max(0, (elapsed / duration) * 100)) : 0,
  );

  let nowPath = $derived(store.player?.now_playing ?? null);
  let nowRow = $derived(nowPath ? store.trackForPath(nowPath) : undefined);
  let shownFunkot = $derived(nowRow ? (nowRow.label ?? nowRow.is_funkot) : null);
  let labelProgress = $derived(store.labelProgress);
  let showLogLink = $derived(phase === "failed" || store.lastError !== null);
  let showOpenMusic = $derived(store.lastError !== null && store.lastError.includes("need >= 1 track"));

  let mode = $derived(resolvePrimaryMode(phase, paused, auditioning));
  let primaryLabel = $derived(mode === "pause" ? t.pause : mode === "resume" ? t.resumePlayback : t.start);
  let primaryBusy = $state(false);
  let primaryDisabled = $derived(mode === "off" || primaryBusy || (mode === "start" && !store.canStart));
  let nextDisabled = $derived(
    !canSkipNext(phase, auditioning, store.queue) || store.player?.playback_started_frames == null || store.skipNextPending !== null,
  );

  let transition = $derived(store.player?.last_transition ?? null);
  let flagBusy = $state(false);
  let flagEnabled = $derived(transition !== null && !auditioning);
  let pair = $derived(
    transition
      ? `${store.titleForPath(transition.from)} → ${store.titleForPath(transition.to)} · ${formatAgo(transition.seconds_ago)}`
      : t.noTransitionYet,
  );

  let auditionFrom = $derived(store.player?.audition_from ?? null);
  let auditionTo = $derived(store.player?.audition_to ?? null);
  let auditionLabel = $derived(auditionFrom && auditionTo ? t.auditioning(auditionFrom, auditionTo) : t.autoplayInterrupted);
  let resumeBusy = $state(false);
  let openMusicBusy = $state(false);
  let labelBusy = $state(false);

  async function onPrimaryClick() {
    if (primaryBusy) return;
    primaryBusy = true;
    try {
      if (mode === "start") await store.doStart();
      else if (mode === "pause" || mode === "resume") await store.doTogglePause();
    } finally {
      primaryBusy = false;
    }
  }
  async function onNextClick() {
    if (!nextDisabled) await store.doSkipNext();
  }
  async function onFlagClick() {
    if (flagBusy || !flagEnabled) return;
    flagBusy = true;
    try {
      const result = await store.doFlagLastTransition();
      if (result) toast.show(t.flagRecorded(result.from_title, result.to_title), () => store.doUndoLastFlag());
    } finally {
      flagBusy = false;
    }
  }
  async function onResumeAutodj() {
    if (resumeBusy) return;
    resumeBusy = true;
    try {
      await store.doResumeAutodj();
    } finally {
      resumeBusy = false;
    }
  }
  async function onOpenMusicDir() {
    if (openMusicBusy) return;
    openMusicBusy = true;
    try {
      toast.notify(await openMusicDir());
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
      toast.show(next ? t.labeledFunkot : t.labeledNotFunkot, async () => (await store.doSetLabel(nowPath!, prevLabel)) !== null);
    } finally {
      labelBusy = false;
    }
  }
</script>

<div class="playback-bar" class:auditioning role="toolbar" aria-label={t.playbackControlsLabel}>
  <div class="bar" aria-hidden="true"><div class="bar-fill" style={`width: ${progressPct}%`}></div></div>
  <div class="inner">
    {#if auditioning}
      <span class="what">{auditionLabel}</span>
      <button type="button" class="primary" disabled={resumeBusy} onclick={onResumeAutodj}>{t.resumeAction}</button>
    {:else}
      <div class="now">
        <div class="line">
          <span class={`badge ${phase}`}>{phaseText(t, phase)}</span>
          <span class="title">{store.nowTitle ?? ""}</span>
        </div>
        <div class="line sub">
          <span class="artist">{store.nowArtist}</span>
          <span class="time">{formatTime(elapsed)} / {formatTime(duration)}</span>
          {#if store.labelingMode}<span class="time">{labelProgress.current} / {labelProgress.total}</span>{/if}
        </div>
      </div>
      <div class="track-acts">
        {#if showLogLink}<button type="button" class="quiet link" onclick={() => (ui.logOpen = true)}>{t.showLog}</button>{/if}
        {#if showOpenMusic}<button type="button" class="quiet link" disabled={openMusicBusy} onclick={onOpenMusicDir}>{t.openMusicFolder}</button>{/if}
        {#if nowRow && shownFunkot !== null}
          <button type="button" class="quiet link" disabled={labelBusy} onclick={onToggleLabel}>{shownFunkot ? t.funkot : t.notFunkot}</button>
        {/if}
        {#if nowRow}<FavoriteButton path={nowRow.path} contentHash={nowRow.content_hash} title={nowRow.title} />{/if}
      </div>
      <div class="controls">
        <button type="button" class="play" class:resume={mode === "resume"} disabled={primaryDisabled} onclick={onPrimaryClick}>{primaryLabel}</button>
        <button type="button" class="next" disabled={nextDisabled} onclick={onNextClick} aria-label={t.nextTrackLabel} title={t.nextTrackLabel}>⏭</button>
        <button
          type="button"
          class="flag"
          disabled={!flagEnabled || flagBusy}
          aria-label={t.flagBadTransition}
          aria-describedby="last-transition-pair"
          title={t.flagBadTransition}
          onclick={onFlagClick}
        >⚑ <span class="pair" id="last-transition-pair">{pair}</span></button>
      </div>
    {/if}
  </div>
</div>

<style>
  .playback-bar {
    flex: none;
    container-type: inline-size;
    background: var(--color-playback-bar-bg);
    border-top: 1px solid var(--color-border);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .playback-bar.auditioning { background: var(--color-audition-banner-bg); }
  .bar { height: 3px; background: var(--color-border); }
  .bar-fill { height: 100%; background: var(--color-status-playing); }
  .inner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-xs) var(--space-md);
    padding: var(--space-sm) var(--shell-pad);
  }
  .what { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .now { flex: 1 1 0; min-width: 0; }
  .line { display: flex; align-items: baseline; gap: var(--space-sm); min-width: 0; line-height: 1.3; }
  .title, .artist { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .title { font-size: var(--font-size-md); }
  .sub { font-size: var(--font-size-sm); color: var(--color-text-dim); }
  .artist { flex: 0 1 auto; }
  .time { flex: none; font-variant-numeric: tabular-nums; }
  .badge { flex: none; font-size: var(--font-size-sm); }
  .badge.idle { color: var(--color-status-idle); }
  .badge.starting { color: var(--color-status-starting); }
  .badge.playing { color: var(--color-status-playing); }
  .badge.paused { color: var(--color-status-paused); }
  .badge.stalled { color: var(--color-status-stalled); }
  .badge.failed { color: var(--color-status-failed); }
  .badge.disconnected { color: var(--color-status-disconnected); }
  .track-acts { flex: none; display: flex; align-items: center; gap: var(--space-xs); }
  .link { text-decoration: underline; }
  .controls { flex: 1 0 100%; display: flex; gap: var(--space-sm); min-width: 0; }
  .play {
    flex: 0 0 auto;
    min-width: 6.5rem;
    background: var(--color-transport-primary-bg);
    color: var(--color-transport-primary-text);
  }
  .play.resume { background: var(--color-transport-paused-bg); color: var(--color-transport-paused-text); }
  .next { flex: 0 0 auto; background: var(--color-transport-secondary-bg); color: var(--color-transport-secondary-text); }
  .flag {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    gap: var(--space-sm);
    align-items: center;
    text-align: start;
    background: transparent;
    color: var(--color-flag-amber);
    border-color: var(--color-flag-amber);
  }
  .pair { min-width: 0; color: var(--color-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .flag:disabled .pair { color: var(--color-disabled-text); }
  .flag:not(:disabled):hover {
    background: color-mix(in srgb, var(--color-flag-amber) 35%, var(--color-bg));
    color: var(--color-text);
    box-shadow: inset 0 0 0 1px var(--color-flag-amber);
  }
  .next:not(:disabled):hover {
    background: var(--color-transport-secondary-text);
    color: var(--color-transport-secondary-bg);
    border-color: var(--color-transport-secondary-text);
  }
  .play:disabled, .next:disabled { background: var(--color-transport-disabled-bg); color: var(--color-transport-disabled-text); }

  @container (min-width: 48rem) {
    .inner { flex-wrap: nowrap; }
    .controls { order: -1; flex: 0 1 26rem; }
    .now { display: flex; align-items: baseline; gap: var(--space-md); }
    .line { flex: 0 1 auto; }
  }
</style>
