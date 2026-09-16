<script lang="ts">
  import type { TrackTagState } from "../lib/tauri";
  let { state }: { state: TrackTagState | null } = $props();
  // One readable line, with no per-token truncation or duplicate entrypoints.
  // Complete values and metadata status remain available in the tag editor.
  let compact = $derived(["year", "genre", "custom"].flatMap(kind => {
    const tag = state?.effective.find(tag => tag.kind === kind);
    return tag ? [tag.value] : [];
  }));
  let remaining = $derived((state?.effective.length ?? 0) - compact.length);
  let summary = $derived(compact.join(" · ") + (remaining > 0 ? ` · +${remaining}` : ""));
</script>

{#if compact.length}
  <div class="tag-summary" title={summary}>{summary}</div>
{/if}

<style>
  .tag-summary { margin-top: var(--space-xs); color: var(--color-text-dim); font-size: var(--font-size-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
