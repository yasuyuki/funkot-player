export type PlaySub = "queue" | "library" | "history";

class UiStore {
  menuOpen = $state(false);
  logOpen = $state(false);
  mode = $state<"play" | "edit">("play");
  playSub = $state<PlaySub>("library");
  editSub = $state<"flags" | "all">("flags");
  flaggedDetailKey = $state<{ trackHash: string; role: string } | null>(null);

  setMode(mode: "play" | "edit"): void {
    this.mode = mode;
    if (mode === "play") {
      this.flaggedDetailKey = null;
    }
  }

  setPlaySub(sub: PlaySub): void {
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
