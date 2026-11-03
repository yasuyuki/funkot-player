const AUTO_DISMISS_MS = 8000;

export const BULK_DISMISS_MS = 20000;

class ToastStore {
  message = $state<string | null>(null);
  busy = $state(false);
  undoable = $state(false);

  #onUndo: (() => Promise<boolean>) | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
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

  async undo(): Promise<void> {
    if (this.busy || !this.#onUndo) return;
    const generation = this.#generation;
    this.busy = true;
    try {
      const ok = await this.#onUndo();
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
