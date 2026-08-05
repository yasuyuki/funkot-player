<script lang="ts">
  import { ui } from "./lib/ui.svelte";
  import NowCard from "./components/NowCard.svelte";
  import TransitionStrip from "./components/TransitionStrip.svelte";
  import Transport from "./components/Transport.svelte";
  import OverflowMenu from "./components/OverflowMenu.svelte";
  import Toast from "./components/Toast.svelte";
  import LogView from "./components/LogView.svelte";
  import Queue from "./components/Queue.svelte";
  import Library from "./components/Library.svelte";
  import MiniBar from "./components/MiniBar.svelte";

  /// True while the transport sentinel intersects the viewport. MiniBar
  /// flips on when this goes false (user scrolled the transport away).
  let transportVisible = $state(true);
  let sentinelEl = $state<HTMLElement | null>(null);

  $effect(() => {
    const el = sentinelEl;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      transportVisible = entry?.isIntersecting ?? true;
    });
    io.observe(el);
    return () => io.disconnect();
  });
</script>

<div class="header">
  <h1 class="app-title">funkot-player</h1>
  <OverflowMenu />
</div>

<NowCard />

<!-- TransitionStrip and Transport are independent of each other (plan
     section 3b), so the only thing deciding which comes first is each
     block's CSS `order` below -- flipping `ui.stripFirst` never touches
     this markup. -->
<div class="playback-blocks">
  <div class="strip-block" style={`order: ${ui.stripFirst ? 0 : 1}`}>
    <TransitionStrip />
  </div>
  <div class="transport-block" style={`order: ${ui.stripFirst ? 1 : 0}`}>
    <Transport />
    <!-- Tied to Transport, not the whole playback-blocks: when strip is below
         transport, scrolling transport away must still reveal MiniBar. -->
    <div class="minibar-sentinel" bind:this={sentinelEl} aria-hidden="true"></div>
  </div>
</div>

<Toast />

<LogView />

<Queue />
<Library />
<MiniBar {transportVisible} />

<style>
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    margin-bottom: var(--space-lg);
  }

  .app-title {
    color: var(--color-text);
    font-size: var(--font-size-lg);
    margin: 0;
  }

  /* The gap lives here, not as a margin on either block: whichever of the
     two ends up second (ui.stripFirst) still needs the same separation, and
     a margin on one of them only works for one of the two orders. */
  .playback-blocks {
    display: flex;
    flex-direction: column;
    gap: var(--space-lg);
  }

  .minibar-sentinel {
    height: 1px;
    margin: 0;
    pointer-events: none;
  }
</style>
