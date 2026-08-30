<script lang="ts">
  import { tick } from "svelte";
  import { ui } from "./lib/ui.svelte";
  import { store } from "./lib/state.svelte";
  import { sessionActive } from "./lib/transportMode";
  import UiBoundary from "./components/UiBoundary.svelte";
  import NowCard from "./components/NowCard.svelte";
  import AuditionBanner from "./components/AuditionBanner.svelte";
  import NewArrivalsBanner from "./components/NewArrivalsBanner.svelte";
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

  /// Last scroll offset per play subtab. Deliberately not `$state`: nothing
  /// renders from it, and a reactive write inside the swap would be one more
  /// thing to order against `tick`.
  let scrollByPlaySub: Record<"queue" | "library", number> = { queue: 0, library: 0 };

  /// The document scrolls (`body` in tokens.css carries the padding; neither
  /// pane is its own scroll container), so hiding a pane changes the page
  /// height and the browser clamps the offset. Save before the swap, restore
  /// after the DOM has the new height -- otherwise coming back to a library of
  /// hundreds of rows always lands at the top, which is the same "the list is
  /// far away" problem this split exists to fix. A restore past the new bottom
  /// is clamped by the browser, so there is nothing to clamp here.
  async function onPlaySub(sub: "queue" | "library") {
    if (ui.playSub === sub) return;
    scrollByPlaySub[ui.playSub] = window.scrollY;
    ui.setPlaySub(sub);
    await tick();
    window.scrollTo(0, scrollByPlaySub[sub]);
  }

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

  // Labeling shortcuts: F = Funkot (+skip when labeling mode on), J =
  // non-Funkot (+skip when on), Space = skip only when labeling mode on.
  // Disabled while typing in inputs (covers Library search). No toast on the
  // keyboard path — click UI owns undo toasts.
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) {
        return;
      }
      const key = e.key;
      if (key === "f" || key === "F") {
        e.preventDefault();
        void store.doLabelAndSkip(true);
      } else if (key === "j" || key === "J") {
        e.preventDefault();
        void store.doLabelAndSkip(false);
      } else if (key === " " && store.labelingMode) {
        e.preventDefault();
        void store.doLabelAndSkip(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<div class="header">
  <h1 class="app-title">Funkot</h1>
  <UiBoundary>
    <OverflowMenu />
  </UiBoundary>
</div>

{#if store.player?.auditioning}
  <UiBoundary>
    <AuditionBanner />
  </UiBoundary>
{:else}
  <UiBoundary>
    <NowCard />
  </UiBoundary>
{/if}

<div class="playback-blocks">
  <div class="transport-block">
    <UiBoundary>
      <Transport />
    </UiBoundary>
    <!-- Tied to Transport, not the whole playback-blocks: scrolling transport
         away must still reveal MiniBar even when TransitionStrip follows. -->
    <div class="minibar-sentinel" bind:this={sentinelEl} aria-hidden="true"></div>
  </div>
  <div class="strip-block">
    <UiBoundary>
      <TransitionStrip />
    </UiBoundary>
  </div>
</div>

<UiBoundary>
  <Toast raised={miniBarVisible} />
</UiBoundary>

<UiBoundary>
  <LogView />
</UiBoundary>

{#if ui.mode === "play"}
  <!-- Above the subtabs rather than inside Library: the arrivals banner is
       meant to be standing, and from inside a pane it would disappear whenever
       the queue tab is up. It renders nothing while there are no actionable
       arrivals, so the tabs do not move on an ordinary launch. -->
  <UiBoundary>
    <NewArrivalsBanner />
  </UiBoundary>

  <div class="subtabs" role="tablist" aria-label="再生サブタブ">
    <button
      type="button"
      class="tab"
      class:active={ui.playSub === "queue"}
      role="tab"
      aria-selected={ui.playSub === "queue"}
      onclick={() => onPlaySub("queue")}
    >次に再生</button>
    <button
      type="button"
      class="tab"
      class:active={ui.playSub === "library"}
      role="tab"
      aria-selected={ui.playSub === "library"}
      onclick={() => onPlaySub("library")}
    >ライブラリ</button>
  </div>

  <!-- Both panes stay mounted and the inactive one is `hidden`. An `{#if}`
       would unmount Library and drop its search text, sort key and 新着のみ
       state on every tab tap. -->
  <div class="pane" hidden={ui.playSub !== "queue"}>
    <UiBoundary>
      <Queue />
    </UiBoundary>
  </div>
  <div class="pane" hidden={ui.playSub !== "library"}>
    <UiBoundary>
      <Library />
    </UiBoundary>
  </div>

  <!-- Outside the panes: the bar belongs to play mode, not to one tab. -->
  <UiBoundary>
    <MiniBar show={miniBarVisible} />
  </UiBoundary>
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
      <UiBoundary>
        <FlaggedDetail />
      </UiBoundary>
    {:else}
      <UiBoundary>
        <FlaggedList />
      </UiBoundary>
    {/if}
  {:else}
    <UiBoundary>
      <AllTracks />
    </UiBoundary>
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

  /* The panes exist only to carry `hidden`, so they get no display of their
     own; the sections inside bring their own margins. Spelled out because a
     future `display:` here would silently defeat the attribute. */
  .pane[hidden] {
    display: none;
  }
</style>
