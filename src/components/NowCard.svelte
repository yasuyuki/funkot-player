<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { ui } from "../lib/ui.svelte";

  const PHASE_LABEL: Record<string, string> = {
    idle: "待機中",
    starting: "準備中",
    playing: "再生中",
    paused: "一時停止",
    stalled: "次の曲を準備中",
    failed: "再生できません",
    disconnected: "出力先を再接続中",
  };

  function formatTime(secs: number | null): string {
    if (secs === null || !Number.isFinite(secs)) return "--:--";
    const total = Math.max(0, Math.floor(secs));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  let phase = $derived(store.player?.phase ?? "idle");
  let phaseLabel = $derived(PHASE_LABEL[phase] ?? phase);
  let elapsed = $derived(store.elapsed);
  let duration = $derived(store.player?.duration_secs ?? null);
  let progressPct = $derived(
    duration !== null && duration > 0 && elapsed !== null
      ? Math.min(100, Math.max(0, (elapsed / duration) * 100))
      : 0,
  );

  // `lastError` is included, not just `phase === "failed"`, because the
  // always-on `#log` from legacy/index.html is gone (behind the ⋮ menu
  // now): without this an `invoke` failure that does not also flip the
  // phase (e.g. a failed `skip_next` while still playing) would be
  // completely invisible.
  let showLogLink = $derived(phase === "failed" || store.lastError !== null);
</script>

<div class="now-card">
  <span class="badge" class:idle={phase === "idle"} class:starting={phase === "starting"}
    class:playing={phase === "playing"} class:paused={phase === "paused"}
    class:stalled={phase === "stalled"} class:failed={phase === "failed"}
    class:disconnected={phase === "disconnected"}>
    {phaseLabel}
  </span>

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

  {#if showLogLink}
    <button type="button" class="log-link" onclick={() => (ui.logOpen = true)}>
      ログを表示
    </button>
  {/if}
</div>

<style>
  .now-card {
    margin-bottom: var(--space-lg);
  }

  .badge {
    display: inline-block;
    font-size: var(--font-size-sm);
    margin-bottom: var(--space-sm);
  }
  .badge.idle { color: var(--color-status-idle); }
  .badge.starting { color: var(--color-status-starting); }
  .badge.playing { color: var(--color-status-playing); }
  .badge.paused { color: var(--color-status-paused); }
  .badge.stalled { color: var(--color-status-stalled); }
  .badge.failed { color: var(--color-status-failed); }
  .badge.disconnected { color: var(--color-status-disconnected); }

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

  /* Overrides tokens.css's default `button` (full width, large padding):
     this is an inline text link under the card, not a standalone control. */
  .log-link {
    width: auto;
    font-size: var(--font-size-sm);
    padding: 0;
    margin-top: var(--space-sm);
    background: transparent;
    color: var(--color-link);
    text-decoration: underline;
    border-radius: 0;
  }
</style>
