<script lang="ts">
  import { ui, type PlaySub } from "./lib/ui.svelte";
  import { i18n } from "./lib/i18n.svelte";
  import { store } from "./lib/state.svelte";
  import UiBoundary from "./components/UiBoundary.svelte";
  import NewArrivalsBanner from "./components/NewArrivalsBanner.svelte";
  import PlaybackRecovery from "./components/PlaybackRecovery.svelte";
  import OverflowMenu from "./components/OverflowMenu.svelte";
  import PlaybackBar from "./components/PlaybackBar.svelte";
  import Toast from "./components/Toast.svelte";
  import LogView from "./components/LogView.svelte";
  import Queue from "./components/Queue.svelte";
  import Library from "./components/Library.svelte";
  import History from "./components/History.svelte";
  import FlaggedList from "./components/edit/FlaggedList.svelte";
  import FlaggedDetail from "./components/edit/FlaggedDetail.svelte";
  import AllTracks from "./components/edit/AllTracks.svelte";
  import TagEditor from "./components/TagEditor.svelte";
  import { tagEditorSession } from "./lib/tag-editor.svelte";

  let t = $derived(i18n.t);

  let leftSub = $derived(ui.playSub === "history" ? "history" : "library");

  function onPlaySub(sub: PlaySub) {
    ui.setPlaySub(sub);
  }

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

<div class="nav">
  <h1 class="sr-only">Funkot</h1>
  <div class="mode-switch" role="tablist">
    <button type="button" class="mode" class:active={ui.mode === "play"} role="tab" aria-selected={ui.mode === "play"}
      aria-label={t.toPlayModeLabel} onclick={() => ui.setMode("play")}>{t.playMode}</button>
    <button type="button" class="mode" class:active={ui.mode === "edit"} role="tab" aria-selected={ui.mode === "edit"}
      aria-label={t.toEditModeLabel} onclick={() => ui.setMode("edit")}>{t.editMode}</button>
  </div>
  {#if ui.mode === "play"}
    <div class="subtabs play" role="tablist" aria-label={t.playTabsLabel}>
      <button type="button" class="tab queue" class:active={ui.playSub === "queue"} role="tab"
        aria-selected={ui.playSub === "queue"} onclick={() => onPlaySub("queue")}>{t.queueHeading}</button>
      <button type="button" class="tab" class:active={ui.playSub === "library"} class:left={leftSub === "library"} role="tab"
        aria-selected={ui.playSub === "library"} onclick={() => onPlaySub("library")}>{t.libraryHeading}</button>
      <button type="button" class="tab" class:active={ui.playSub === "history"} role="tab"
        aria-selected={ui.playSub === "history"} onclick={() => onPlaySub("history")}>{t.historyHeading}</button>
    </div>
  {:else}
    <div class="subtabs" role="tablist" aria-label={t.editTabsLabel}>
      <button type="button" class="tab" class:active={ui.editSub === "flags"} role="tab"
        aria-selected={ui.editSub === "flags"} onclick={() => ui.setEditSub("flags")}>{t.tabFlags}</button>
      <button type="button" class="tab" class:active={ui.editSub === "all"} role="tab"
        aria-selected={ui.editSub === "all"} onclick={() => ui.setEditSub("all")}>{t.tabAllTracks}</button>
    </div>
  {/if}
  <UiBoundary>
    <OverflowMenu />
  </UiBoundary>
</div>

<div class="main" class:play={ui.mode === "play"}>
  <UiBoundary>
    <LogView />
  </UiBoundary>
  {#if ui.mode === "play"}
    <UiBoundary>
      <PlaybackRecovery />
    </UiBoundary>
    <UiBoundary>
      <NewArrivalsBanner />
    </UiBoundary>
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
  {:else if ui.editSub === "flags"}
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
</div>

<UiBoundary>
  <Toast />
</UiBoundary>

<UiBoundary>
  <PlaybackBar />
</UiBoundary>

<style>
  .nav {
    flex: none;
    display: flex;
    align-items: start;
    gap: var(--space-sm);
    padding: 0 var(--shell-pad) var(--space-sm);
    border-bottom: 1px solid var(--color-border);
  }

  .mode-switch { display: flex; flex: none; gap: var(--space-xs); }
  /* A tab label is never cut short: tabs that do not fit one line move to the next, and a tab wider than the line wraps its text. */
  .subtabs { display: flex; flex-wrap: wrap; flex: 1 1 0; min-width: 0; gap: var(--space-xs); }
  .subtabs .tab { flex: 1 1 auto; padding-inline: var(--space-xs); }
  .mode.active, .subtabs .tab.active {
    background: var(--color-tab-active-bg);
    color: var(--color-tab-active-text);
  }
  .nav > :global(:last-child) { margin-left: auto; }

  .main {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 var(--shell-pad);
  }
  .main.play { display: flex; flex-direction: column; overflow: hidden; }

  .panes { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--browse-gutter); }
  .pane { min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .panes > .pane:not(.active) { display: none; }

  /* Below two panes the selected mode names itself through its tabs, so only the way out is shown. */
  @container shell not (min-width: 48rem) {
    .mode.active { display: none; }
  }

  @container shell (min-width: 48rem) {
    .panes { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); }
    .panes > .pane.queue, .panes > .pane.library { display: block; }
    .panes > .pane.history { display: none; }
    .panes.history-left > .pane.library { display: none; }
    .panes.history-left > .pane.history { display: block; }
  }

  @container shell (min-width: 72rem) {
    .panes { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr); }
    .panes > .pane.queue,
    .panes > .pane.library,
    .panes > .pane.history,
    .panes.history-left > .pane.library,
    .panes.history-left > .pane.history { display: block; }
  }

  @container shell (min-width: 48rem) {
    .subtabs.play .tab.queue { display: none; }
    .subtabs.play .tab.left { background: var(--color-tab-active-bg); color: var(--color-tab-active-text); }
    .subtabs { flex: 0 1 auto; }
    .subtabs .tab { flex: 0 1 auto; padding-inline: var(--control-pad-inline); }
  }
  @container shell (min-width: 72rem) {
    .subtabs.play { display: none; }
  }
</style>
{#if tagEditorSession.current}
  <TagEditor {...tagEditorSession.current} onclose={tagEditorSession.close} />
{/if}
