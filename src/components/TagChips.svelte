<script lang="ts">
  import { i18n } from "../lib/i18n.svelte";
  import type { TrackTagState } from "../lib/tauri";
  import type { TagChoice } from "../lib/tag-filter";
  let { state, onchoose, ondetails }: {
    state: TrackTagState | null;
    onchoose: (tag: TagChoice) => void;
    ondetails: (event: MouseEvent) => void;
  } = $props();
  let t = $derived(i18n.t);
  // Keep one representative of each supported kind. Full sets belong in the
  // editor; long names cannot take space from the title or queue button.
  let compact = $derived(["year", "genre", "custom"].flatMap(kind => {
    const tag = state?.effective.find(tag => tag.kind === kind);
    return tag ? [tag] : [];
  }));
  let remaining = $derived((state?.effective.length ?? 0) - compact.length);
  function kindLabel(kind: string) { return kind === "year" ? t.tagYear : kind === "genre" ? t.tagGenre : t.tagCustom; }
</script>

{#if compact.length}
  <div class="chips">
    {#each compact as tag (tag.key)}
      <button type="button" title={`${kindLabel(tag.kind)}: ${tag.value}`}
        aria-label={t.tagFilterChoose(kindLabel(tag.kind), tag.value)}
        onpointerdown={event => event.stopPropagation()}
        onclick={event => { event.stopPropagation(); onchoose(tag); }}>
        {kindLabel(tag.kind)}: {tag.value}
      </button>
    {/each}
    {#if remaining > 0}<button type="button" class="more" aria-label={t.tagMore(remaining)}
      onpointerdown={event => event.stopPropagation()} onclick={event => { event.stopPropagation(); ondetails(event); }}>+{remaining}</button>{/if}
  </div>
{/if}
{#if !state || state.metadata_status !== "ready"}
  <span class="status">{t.tagMetadataStatus(state?.metadata_status ?? "pending")}</span>
{/if}

<style>
  .chips { display: flex; gap: var(--space-xs); min-width: 0; margin-top: var(--space-xs); }
  button { flex: 1 1 0; width: auto; min-width: 0; padding: 2px var(--space-xs); border: 1px solid var(--color-border); background: var(--color-menu-bg); color: var(--color-text-dim); font-size: var(--font-size-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: start; }
  .more { flex: 0 0 auto; }
  .status { display: block; font-size: var(--font-size-sm); color: var(--color-text-dim); }
</style>
