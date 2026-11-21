<script lang="ts">
  import type { TrackTagState } from "../lib/tauri";
  let { state }: { state: TrackTagState | null } = $props();
  let compact = $derived(["year", "genre", "custom"].flatMap(kind => {
    const tag = state?.effective.find(tag => tag.kind === kind);
    return tag ? [tag] : [];
  }));
  let remaining = $derived((state?.effective.length ?? 0) - compact.length);
  let summary = $derived(compact.map(tag => tag.value).join(" · ") + (remaining > 0 ? ` · +${remaining}` : ""));
</script>

{#if compact.length}
  <div class="tag-summary" title={summary}>
    {#each compact as tag (tag.key)}
      <span class={`tag-pill kind-${tag.kind}`}>{tag.value}</span>
    {/each}
    {#if remaining > 0}
      <span class="tag-pill kind-more">+{remaining}</span>
    {/if}
  </div>
{/if}

<style>
  .tag-summary {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-top: var(--space-xs);
    color: var(--color-text-dim);
    font-size: var(--font-size-sm);
    white-space: nowrap;
    overflow: hidden;
  }
  .tag-pill {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 0.32rem;
    border-radius: var(--radius-sm);
    font-size: 0.72rem;
    line-height: 1.25;
  }
  .tag-pill.kind-year {
    flex: 0 0 auto;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    background: var(--color-pill-year-bg);
    color: var(--color-pill-year-text);
  }
  .tag-pill.kind-genre {
    flex: 0 0 auto;
    background: var(--color-pill-genre-bg);
    color: var(--color-pill-genre-text);
  }
  .tag-pill.kind-custom {
    background: var(--color-pill-custom-bg);
    color: var(--color-pill-custom-text);
  }
  .tag-pill.kind-more {
    flex: 0 0 auto;
    background: var(--color-pill-year-bg);
    color: var(--color-text-dim);
  }
</style>
