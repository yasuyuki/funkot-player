// Single shared toast slot, carried over from legacy/index.html's
// `showUndoToast` (and its comment, verbatim in spirit): a new `show`
// replaces whatever toast is currently up. legacy used this one slot for the
// flag toast, the queue-removal toast, and the bar-count-edit toast alike;
// stage 4's edit-tab actions reuse this same store rather than each owning a
// toast, so two of them can never stack on screen at once.
const AUTO_DISMISS_MS = 8000;

/// For actions whose 取消 is the only way back and which touch many tracks at
/// once (folder labeling). The toast is docked to the bottom edge while the
/// user is reading rows in the middle of an 800-row table, so the default
/// window is easy to miss entirely — and a bulk label missed here costs a
/// folder's worth of judgements to redo, not one.
export const BULK_DISMISS_MS = 20000;

class ToastStore {
  message = $state<string | null>(null);
  /// Disabled while an undo is in flight, same reasoning as Transport's
  /// busy guard: every command round-trips through the host.
  busy = $state(false);
  /// When false, the toast is notify-only (no 取消).
  undoable = $state(false);

  #onUndo: (() => Promise<boolean>) | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /// Bumped by every `show`. `undo` captures it and refuses to close a
  /// toast that is no longer the one it started on -- an undo round-trips
  /// through the host, and a second flag landing in that window replaces
  /// the toast, whose 取消 the user has not used yet.
  #generation = 0;

  show(
    message: string,
    onUndo: () => Promise<boolean>,
    dismissMs: number = AUTO_DISMISS_MS,
  ): void {
    this.#clearTimer();
    this.#generation += 1;
    this.message = message;
    this.#onUndo = onUndo;
    this.undoable = true;
    this.busy = false;
    this.#timer = setTimeout(() => this.dismiss(), dismissMs);
  }

  /// Notify-only toast: no 取消, auto-dismisses like `show`.
  notify(message: string): void {
    this.#clearTimer();
    this.#generation += 1;
    this.message = message;
    this.#onUndo = null;
    this.undoable = false;
    this.busy = false;
    this.#timer = setTimeout(() => this.dismiss(), AUTO_DISMISS_MS);
  }

  dismiss(): void {
    this.#clearTimer();
    this.message = null;
    this.#onUndo = null;
    this.undoable = false;
    this.busy = false;
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /// Runs the toast's `onUndo`. Closes the toast only when it reports
  /// success: `undo_last_flag` (src-tauri/src/lib.rs) only consumes its
  /// undo token once the write to disk lands, specifically so a failed save
  /// leaves 取消 usable again -- closing the toast on a `false` result would
  /// strand that retry behind a toast the user can no longer see.
  async undo(): Promise<void> {
    if (this.busy || !this.#onUndo) return;
    const generation = this.#generation;
    this.busy = true;
    try {
      const ok = await this.#onUndo();
      // Only dismiss if this is still the same toast: `show` may have
      // replaced it while the undo was in flight (see `#generation`), and
      // closing the newer one would drop a 取消 the user never saw.
      if (ok && generation === this.#generation) {
        this.dismiss();
      }
    } finally {
      if (generation === this.#generation) {
        this.busy = false;
      }
    }
  }
}

export const toast = new ToastStore();
