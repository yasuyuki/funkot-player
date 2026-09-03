<script lang="ts">
  import { tick } from "svelte";
  import { ui, type PlaySub } from "./lib/ui.svelte";
  import { i18n } from "./lib/i18n.svelte";
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
  import History from "./components/History.svelte";
  import MiniBar from "./components/MiniBar.svelte";
  import FlaggedList from "./components/edit/FlaggedList.svelte";
  import FlaggedDetail from "./components/edit/FlaggedDetail.svelte";
  import AllTracks from "./components/edit/AllTracks.svelte";

  /// True while the transport sentinel intersects the viewport. MiniBar
  /// flips on when this goes false (user scrolled the transport away).
  let t = $derived(i18n.t);

  let transportVisible = $state(true);
  let sentinelEl = $state<HTMLElement | null>(null);

  /// Whether MiniBar is on screen. Derived here rather than inside MiniBar
  /// because Toast docks on top of it and needs the same answer.
  ///
  /// Edit mode draws no transport at all, so there is no sentinel to scroll
  /// away and the bar is unconditionally the only playback control there --
  /// it is what "the session keeps running while you edit" is made of. In
  /// play mode it still waits for the transport row to leave the viewport.
  let miniBarVisible = $derived(
    sessionActive(store.player?.phase ?? "idle", store.player?.auditioning ?? false) &&
      (ui.mode === "edit" || !transportVisible),
  );

  /// Last scroll offset per play subtab. Deliberately not `$state`: nothing
  /// renders from it, and a reactive write inside the swap would be one more
  /// thing to order against `tick`.
  let scrollByPlaySub: Record<PlaySub, number> = { queue: 0, library: 0, history: 0 };

  /// Which screen the left column shows once both columns are up. The queue
  /// is pinned on the right there, so `playSub === "queue"` -- which a narrow
  /// window can leave behind when it is widened -- still has to resolve to a
  /// left-hand screen, and the library is the one to fall back to.
  let leftSub = $derived(ui.playSub === "history" ? "history" : "library");

  /// The document scrolls (`body` in tokens.css carries the padding; neither
  /// pane is its own scroll container), so hiding a pane changes the page
  /// height and the browser clamps the offset. Save before the swap, restore
  /// after the DOM has the new height -- otherwise coming back to a library of
  /// hundreds of rows always lands at the top, which is the same "the list is
  /// far away" problem this split exists to fix. A restore past the new bottom
  /// is clamped by the browser, so there is nothing to clamp here.
  async function onPlaySub(sub: PlaySub) {
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

  // Keep the document language in step with the UI language: line breaking
  // and the font the WebView picks for CJK vs Latin text both key off it, and
  // a stale `lang` is what makes a switched-to-English screen still break
  // lines as if it were Japanese.
  $effect(() => {
    document.documentElement.lang = i18n.locale;
  });

  // Load flagged rows only when the edit → flagged-transitions panel is showing
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

<!-- Mode lives in the header rather than down among the playback controls:
     it is the one switch that is neither a per-tap playback command nor a
     rare setting, and from here it stays reachable in both modes -- edit
     mode draws none of the blocks the old toggle sat inside. -->
<div class="header">
  <h1 class="app-title">Funkot</h1>
  <div class="mode-switch" role="tablist">
    <button
      type="button"
      class="mode"
      class:active={ui.mode === "play"}
      role="tab"
      aria-selected={ui.mode === "play"}
      aria-label={t.toPlayModeLabel}
      onclick={() => ui.setMode("play")}
    >{t.playMode}</button>
    <button
      type="button"
      class="mode"
      class:active={ui.mode === "edit"}
      role="tab"
      aria-selected={ui.mode === "edit"}
      aria-label={t.toEditModeLabel}
      onclick={() => ui.setMode("edit")}
    >{t.editMode}</button>
  </div>
  <UiBoundary>
    <OverflowMenu />
  </UiBoundary>
</div>

<!-- Auditioning is reachable from the edit side (FlaggedDetail starts it), so
     the banner is drawn in both modes; the rest of the play chrome is not. -->
{#if store.player?.auditioning}
  <UiBoundary>
    <AuditionBanner />
  </UiBoundary>
{:else if ui.mode === "play"}
  <UiBoundary>
    <NowCard />
  </UiBoundary>
{/if}

{#if ui.mode === "play"}
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
{/if}

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

  <!-- The tabs live inside the container, not beside it: a container query
       styles the container's descendants, and hiding the tabs when both panes
       fit is part of that same query. -->
  <div class="browse">
    <!-- The queue tab is hidden once two columns are up (the queue is one of
         them), so at that width these choose the left-hand column and their
         active state follows `leftSub`, not `playSub`. -->
    <div class="subtabs" role="tablist" aria-label={t.playTabsLabel}>
      <button
        type="button"
        class="tab queue"
        class:active={ui.playSub === "queue"}
        role="tab"
        aria-selected={ui.playSub === "queue"}
        onclick={() => onPlaySub("queue")}
      >{t.queueHeading}</button>
      <!-- `left` is what makes the library tab read as selected in the
           two-column band when `playSub` is still "queue" from a narrower
           window. Only the wide band styles it, so no width has to be
           measured in script. -->
      <button
        type="button"
        class="tab"
        class:active={ui.playSub === "library"}
        class:left={leftSub === "library"}
        role="tab"
        aria-selected={ui.playSub === "library"}
        onclick={() => onPlaySub("library")}
      >{t.libraryHeading}</button>
      <button
        type="button"
        class="tab"
        class:active={ui.playSub === "history"}
        role="tab"
        aria-selected={ui.playSub === "history"}
        onclick={() => onPlaySub("history")}
      >{t.historyHeading}</button>
    </div>

    <!-- Sources first, then the queue, so the wide layout reads left-to-right
         the way the work does: find it — in the library, or in what you have
         already played — then add it to what plays next. Library and History
         are alternatives for that left column and only one is ever up, so DOM
         order gives the columns without `order:`, and focus and screen readers
         agree with them. Narrow shows one pane at a time, so the order is
         invisible there and the tab buttons keep their own.

         All three panes stay mounted and the hidden ones are display:none'd by
         class. An `{#if}` would unmount Library and drop its search text, sort
         key, new-arrivals-only state and selection on every tab tap; the
         `hidden` attribute would have to be fought with CSS to show two panes
         at once, which is exactly what it is not for. -->
    <div class="panes" class:history-left={leftSub === "history"}>
      <div class="pane library" class:active={ui.playSub === "library"}>
        <UiBoundary>
          <Library />
        </UiBoundary>
      </div>
      <div class="pane history" class:active={ui.playSub === "history"}>
        <UiBoundary>
          <History />
        </UiBoundary>
      </div>
      <div class="pane queue" class:active={ui.playSub === "queue"}>
        <UiBoundary>
          <Queue />
        </UiBoundary>
      </div>
    </div>
  </div>

{:else}
  <div class="subtabs" role="tablist" aria-label={t.editTabsLabel}>
    <button
      type="button"
      class="tab"
      class:active={ui.editSub === "flags"}
      role="tab"
      aria-selected={ui.editSub === "flags"}
      onclick={() => ui.setEditSub("flags")}
    >{t.tabFlags}</button>
    <button
      type="button"
      class="tab"
      class:active={ui.editSub === "all"}
      role="tab"
      aria-selected={ui.editSub === "all"}
      onclick={() => ui.setEditSub("all")}
    >{t.tabAllTracks}</button>
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

<!-- Outside both modes: the bar belongs to the session, not to a screen, and
     in edit mode it is the only playback control there is. Last in the
     document so its in-flow spacer clears whichever list ends the page. -->
<UiBoundary>
  <MiniBar show={miniBarVisible} />
</UiBoundary>

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
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Segmented, not a pair of standalone buttons: the two share a border and
     only one is filled, so which mode you are in is the same read as the
     subtabs below. `flex: none` keeps it whole and hands any squeeze to the
     title, which is the one thing here that can be clipped. */
  .mode-switch {
    display: flex;
    flex: none;
    gap: var(--space-xs);
  }

  .mode-switch .mode {
    width: auto;
    font-size: var(--font-size-sm);
    padding: var(--space-sm) var(--space-md);
    background: var(--color-tab-bg);
    color: var(--color-tab-text);
  }

  .mode-switch .mode.active {
    background: var(--color-tab-active-bg);
    color: var(--color-tab-active-text);
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

  .browse {
    container-type: inline-size;
    container-name: browse;
  }

  /* The panes carry only their visibility -- the sections inside bring their
     own margins -- plus the min-width a grid item needs before the ellipsis
     inside every row can do its job. */
  .pane {
    min-width: 0;
  }

  /* Narrow: whichever tab is selected, and only that one. */
  .panes > .pane:not(.active) {
    display: none;
  }

  /* 48rem: two --browse-col-min columns plus one --browse-gutter is 744px, so
     this is that floor with a little slack. Spelled out rather than tokenised
     because a container query cannot read a custom property. Measured on the
     browse wrapper, not the viewport, so shell padding -- or the library tree
     column planned for the left of this area -- does not move the switch.

     The queue takes the right column and stays there: picking tracks out of
     the library or out of what you have already played both mean adding them
     to what plays next, and that is worth seeing while you pick. The left
     column is whichever source is selected, so the tabs still have something
     to say here -- only the queue's own tab goes, since it can no longer
     point at anything you are not already looking at. */
  @container browse (min-width: 48rem) {
    .subtabs .tab.queue {
      display: none;
    }

    /* `playSub` can still be "queue" here, carried in from a narrower window;
       `left` is the class that keeps the library tab reading as selected. */
    .subtabs .tab.left {
      background: var(--color-tab-active-bg);
      color: var(--color-tab-active-text);
    }

    .panes {
      display: grid;
      grid-template-columns: repeat(2, minmax(var(--browse-col-min), 1fr));
      gap: var(--browse-gutter);
      /* Top-aligned: the shorter column just ends, leaving space under it.
         No filler, and no per-column scrolling -- the page is one scroll. */
      align-items: start;
    }

    /* Spelled out per pane rather than `:not(.active)`, which only worked
       while there were exactly two of them. */
    .panes > .pane.queue,
    .panes > .pane.library {
      display: block;
    }

    .panes > .pane.history {
      display: none;
    }

    .panes.history-left > .pane.library {
      display: none;
    }

    .panes.history-left > .pane.history {
      display: block;
    }
  }

  /* 70.5rem = 3 x --browse-col-min + 2 x --browse-gutter (1128px), the same
     arithmetic as above with a third column. Below it a third column does not
     fit -- the default desktop window is 1024 wide (tauri.conf.json) -- so
     this band is only reached by widening one on a large monitor. Every pane
     is up under its own heading, and now the tabs really would only be a
     second way to say what you are already looking at. */
  @container browse (min-width: 70.5rem) {
    .subtabs {
      display: none;
    }

    .panes {
      grid-template-columns: repeat(3, minmax(var(--browse-col-min), 1fr));
    }

    /* Every pane, spelled out at the same specificity as the two-column
       band's `display: none` rules above and after them, or those would still
       win and the third column would come up blank. */
    .panes > .pane.queue,
    .panes > .pane.library,
    .panes > .pane.history,
    .panes.history-left > .pane.library,
    .panes.history-left > .pane.history {
      display: block;
    }
  }
</style>
