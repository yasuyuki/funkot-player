<script lang="ts">
  import { store } from "../lib/state.svelte";
  import { toast } from "../lib/toast.svelte";
  import { i18n } from "../lib/i18n.svelte";

  let { path, contentHash, title }: { path: string; contentHash: string | null; title: string } = $props();
  let t = $derived(i18n.t);
  let favorite = $derived(store.isFavorite(contentHash));
  let disabled = $derived(contentHash === null || !store.canFavoriteMutate || store.isFavoriteBusy(path, contentHash));

  async function toggle(): Promise<void> {
    if (disabled) return;
    const result = await store.doSetFavorite(path, !favorite, contentHash);
    if (!result) toast.notify(t.playlistError(store.lastError ?? "busy"));
  }
</script>

<button
  type="button"
  class="favorite quiet icon-button"
  aria-label={favorite ? t.favoriteRemoveLabel(title) : t.favoriteAddLabel(title)}
  aria-pressed={favorite}
  {disabled}
  onclick={() => void toggle()}
>
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 20.5 3.8 12.7A5.4 5.4 0 0 1 11.5 5L12 5.6l.5-.6a5.4 5.4 0 0 1 7.7 7.7Z" />
  </svg>
</button>

<style>
  .favorite { width: auto; flex: 0 0 auto; }
  svg { display: block; width: 1.2rem; height: 1.2rem; fill: none; stroke: currentColor; stroke-width: 1.8; }
  button[aria-pressed="true"] svg { fill: currentColor; }
</style>
