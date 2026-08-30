// Screen-only UI state: menu open, log panel open, mode tabs, and the play /
// edit sub-navigation. None of this is playback state, so it lives here rather
// than in `state.svelte.ts` -- there is nothing here that needs the poll
// loop or its "what changed since last time" guard.

class UiStore {
  menuOpen = $state(false);
  logOpen = $state(false);
  /// Play / edit mode segment. Pure UI: flipping this never invokes transport.
  mode = $state<"play" | "edit">("play");
  /// Play-mode screen. Queue and library are exclusive screens rather than
  /// stacked sections: the startup queue preload restores the persisted queue
  /// before the first poll, so a long queue used to push the library -- the
  /// whole list of files -- off the bottom of the page. Defaults to the
  /// library, which is what gets browsed; the queue is one tap away.
  playSub = $state<"queue" | "library">("library");
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

  /// Deliberately does not reset on `setMode`: coming back from 編集 to the
  /// screen you left is what makes the flag-then-check loop bearable.
  setPlaySub(sub: "queue" | "library"): void {
    this.playSub = sub;
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
