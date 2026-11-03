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
  import PlaybackRecovery from "./components/PlaybackRecovery.svelte";
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
  import TagEditor from "./components/TagEditor.svelte";
  import { tagEditorSession } from "./lib/tag-editor.svelte";

  let t = $derived(i18n.t);

  let transportVisible = $state(true);
  let sentinelEl = $state<HTMLElement | null>(null);

  let miniBarVisible = $derived(
    sessionActive(store.player?.phase ?? "idle", store.player?.auditioning ?? false) &&
      (ui.mode === "edit" || !transportVisible),
  );

  $effect(() => {
    document.documentElement.style.setProperty("--playback-dock-height", miniBarVisible
      ? "calc(var(--minibar-height) + env(safe-area-inset-bottom, 0px))" : "0px");
  });

  let scrollByPlaySub: Record<PlaySub, number> = { queue: 0, library: 0, history: 0 };

  let leftSub = $derived(ui.playSub === "history" ? "history" : "library");

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

  $effect(() => {
    document.documentElement.lang = i18n.locale;
  });

  $effect(() => {
    if (ui.mode === "edit" && ui.editSub === "flags") {
      void store.loadFlaggedTracks();
    }
  });

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
  <UiBoundary>
    <PlaybackRecovery />
  </UiBoundary>
  <div class="playback-blocks">
    <div class="transport-block">
      <UiBoundary>
        <Transport />
      </UiBoundary>
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
  <UiBoundary>
    <NewArrivalsBanner />
  </UiBoundary>

  <div class="browse">
    <div class="subtabs" role="tablist" aria-label={t.playTabsLabel}>
      <button
        type="button"
        class="tab queue"
        class:active={ui.playSub === "queue"}
        role="tab"
        aria-selected={ui.playSub === "queue"}
        onclick={() => onPlaySub("queue")}
      >{t.queueHeading}</button>
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

<UiBoundary>
  <MiniBar show={miniBarVisible} />
</UiBoundary>

<style>
  .header {
    display: flex;
    flex-wrap: wrap;
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

  .mode-switch {
    display: flex;
    flex: none;
    gap: var(--space-xs);
  }

  .mode-switch .mode {
    width: auto;
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
  }

  .subtabs .tab.active {
    background: var(--color-tab-active-bg);
    color: var(--color-tab-active-text);
  }

  .browse {
    container-type: inline-size;
    container-name: browse;
  }

  .pane {
    min-width: 0;
  }

  .panes > .pane:not(.active) {
    display: none;
  }

  /* 48rem >= 2 x --browse-col-min + --browse-gutter (744px); see tokens.css. */
  @container browse (min-width: 48rem) {
    .subtabs .tab.queue {
      display: none;
    }

    .subtabs .tab.left {
      background: var(--color-tab-active-bg);
      color: var(--color-tab-active-text);
    }

    .panes {
      display: grid;
      grid-template-columns: repeat(2, minmax(var(--browse-col-min), 1fr));
      gap: var(--browse-gutter);
      align-items: start;
    }

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

  /* 70.5rem = 3 x --browse-col-min + 2 x --browse-gutter (1128px). */
  @container browse (min-width: 70.5rem) {
    .subtabs {
      display: none;
    }

    .panes {
      grid-template-columns: repeat(3, minmax(var(--browse-col-min), 1fr));
    }

    .panes > .pane.queue,
    .panes > .pane.library,
    .panes > .pane.history,
    .panes.history-left > .pane.library,
    .panes.history-left > .pane.history {
      display: block;
    }
  }
</style>
{#if tagEditorSession.current}
  <TagEditor {...tagEditorSession.current} onclose={tagEditorSession.close} />
{/if}
