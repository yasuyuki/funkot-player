<script lang="ts">
  import { ui } from "./lib/ui.svelte";
  import { store } from "./lib/state.svelte";
  import { sessionActive } from "./lib/transportMode";
  import NowCard from "./components/NowCard.svelte";
  import AuditionBanner from "./components/AuditionBanner.svelte";
  import TransitionStrip from "./components/TransitionStrip.svelte";
  import Transport from "./components/Transport.svelte";
  import OverflowMenu from "./components/OverflowMenu.svelte";
  import Toast from "./components/Toast.svelte";
  import LogView from "./components/LogView.svelte";
  import Queue from "./components/Queue.svelte";
  import Library from "./components/Library.svelte";
  import MiniBar from "./components/MiniBar.svelte";
  import FlaggedList from "./components/edit/FlaggedList.svelte";
  import FlaggedDetail from "./components/edit/FlaggedDetail.svelte";
  import AllTracks from "./components/edit/AllTracks.svelte";

  /// True while the transport sentinel intersects the viewport. MiniBar
  /// flips on when this goes false (user scrolled the transport away).
  let transportVisible = $state(true);
  let sentinelEl = $state<HTMLElement | null>(null);

  /// Whether MiniBar is on screen. Derived here rather than inside MiniBar
  /// because Toast docks on top of it and needs the same answer; the edit
  /// tabs do not mount MiniBar at all, hence the mode test.
  let miniBarVisible = $derived(
    ui.mode === "play" &&
      !transportVisible &&
      sessionActive(store.player?.phase ?? "idle", store.player?.auditioning ?? false),
  );

  $effect(() => {
    const el = sentinelEl;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      transportVisible = entry?.isIntersecting ?? true;
    });
    io.observe(el);
    return () => io.disconnect();
  });

  // Load flagged rows only when the edit → 直すべきつなぎ panel is showing
  // (legacy `showTab` / `showEditSub`). Pure UI otherwise — no transport invoke.
  $effect(() => {
    if (ui.mode === "edit" && ui.editSub === "flags") {
      void store.loadFlaggedTracks();
    }
  });
</script>

<div class="header">
  <h1 class="app-title">Funkot</h1>
  <OverflowMenu />
</div>

{#if store.player?.auditioning}
  <AuditionBanner />
{:else}
  <NowCard />
{/if}

<div class="playback-blocks">
  <div class="transport-block">
    <Transport />
    <!-- Tied to Transport, not the whole playback-blocks: scrolling transport
         away must still reveal MiniBar even when TransitionStrip follows. -->
    <div class="minibar-sentinel" bind:this={sentinelEl} aria-hidden="true"></div>
  </div>
  <div class="strip-block">
    <TransitionStrip />
  </div>
</div>

<Toast raised={miniBarVisible} />

<LogView />

{#if ui.mode === "play"}
  <Queue />
  <Library />
  <MiniBar show={miniBarVisible} />
{:else}
  <div class="subtabs" role="tablist" aria-label="編集サブタブ">
    <button
      type="button"
      class="tab"
      class:active={ui.editSub === "flags"}
      role="tab"
      aria-selected={ui.editSub === "flags"}
      onclick={() => ui.setEditSub("flags")}
    >直すべきつなぎ</button>
    <button
      type="button"
      class="tab"
      class:active={ui.editSub === "all"}
      role="tab"
      aria-selected={ui.editSub === "all"}
      onclick={() => ui.setEditSub("all")}
    >すべての曲</button>
  </div>

  {#if ui.editSub === "flags"}
    {#if ui.flaggedDetailKey}
      <FlaggedDetail />
    {:else}
      <FlaggedList />
    {/if}
  {:else}
    <AllTracks />
  {/if}
{/if}

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

  .playback-blocks {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .minibar-sentinel {
    height: 1px;
    margin: 0;
    pointer-events: none;
  }

  .subtabs {
    display: flex;
    gap: var(--space-xs);
    margin-top: var(--space-md);
  }

  .subtabs .tab {
    flex: 1;
    width: auto;
    font-size: var(--font-size-md);
    padding: var(--space-md) var(--space-lg);
    background: var(--color-tab-bg);
    color: var(--color-tab-text);
  }

  .subtabs .tab.active {
    background: var(--color-tab-active-bg);
    color: var(--color-tab-active-text);
  }
</style>
