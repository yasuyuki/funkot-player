// Screen-only UI state: menu open, log panel open, mode tabs, and edit
// sub-navigation. None of this is playback state, so it lives here rather
// than in `state.svelte.ts` -- there is nothing here that needs the poll
// loop or its "what changed since last time" guard.

class UiStore {
  menuOpen = $state(false);
  logOpen = $state(false);
  /// Play / edit mode segment. Pure UI: flipping this never invokes transport.
  mode = $state<"play" | "edit">("play");
  /// Edit-panel subtab. `flags` = 直すべきつなぎ, `all` = すべての曲.
  editSub = $state<"flags" | "all">("flags");
  /// Open flagged-detail identity, or `null` while the list is showing.
  /// Bars edits mutate the store row in place so reopening the same key keeps
  /// dirty values (legacy closes over the same row object).
  flaggedDetailKey = $state<{ trackHash: string; role: string } | null>(null);

  setMode(mode: "play" | "edit"): void {
    this.mode = mode;
    if (mode === "play") {
      this.flaggedDetailKey = null;
    }
  }

  setEditSub(sub: "flags" | "all"): void {
    this.editSub = sub;
    this.flaggedDetailKey = null;
  }

  openFlaggedDetail(trackHash: string, role: string): void {
    this.flaggedDetailKey = { trackHash, role };
  }

  closeFlaggedDetail(): void {
    this.flaggedDetailKey = null;
  }
}

export const ui = new UiStore();
