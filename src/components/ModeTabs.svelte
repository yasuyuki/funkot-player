<script lang="ts">
  import { ui } from "../lib/ui.svelte";

  function onPlay() {
    ui.setMode("play");
  }

  function onEdit() {
    ui.setMode("edit");
  }
</script>

<!-- Pure UI: switching panels must not invoke start/pause/skip. -->
<div class="tabs" role="tablist" aria-label="表示モード">
  <button
    type="button"
    class="tab"
    class:active={ui.mode === "play"}
    role="tab"
    aria-selected={ui.mode === "play"}
    onclick={onPlay}
  >再生</button>
  <button
    type="button"
    class="tab"
    class:active={ui.mode === "edit"}
    role="tab"
    aria-selected={ui.mode === "edit"}
    onclick={onEdit}
  >編集</button>
</div>

<style>
  .tabs {
    display: flex;
    gap: var(--space-xs);
    margin-top: var(--space-md);
  }

  .tab {
    flex: 1;
    width: auto;
    font-size: var(--font-size-md);
    padding: var(--space-md) var(--space-lg);
    background: var(--color-tab-bg);
    color: var(--color-tab-text);
  }

  .tab.active {
    background: var(--color-tab-active-bg);
    color: var(--color-tab-active-text);
  }
</style>
