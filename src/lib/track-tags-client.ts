import type { TagUpdateRequest, TagUpdateResult, TrackTagsSnapshot } from "./tauri";

// One writer and generation-guarded reads. A scan can finish while an editor
// saves; its requested reload runs after the write, never over its response.
export class TrackTagsClient {
  #generation = 0;
  #saving = false;
  #reloadOwed = false;
  constructor(private io: {
    list: () => Promise<TrackTagsSnapshot>;
    update: (request: TagUpdateRequest) => Promise<TagUpdateResult>;
    changed: (snapshot: TrackTagsSnapshot) => void;
    failed: (error: unknown) => void;
  }) {}

  async reload(): Promise<void> {
    if (this.#saving) { this.#reloadOwed = true; return; }
    const generation = ++this.#generation;
    try {
      const snapshot = await this.io.list();
      if (generation === this.#generation) this.io.changed(snapshot);
    } catch (error) {
      if (generation === this.#generation) this.io.failed(error);
    }
  }

  async save(request: TagUpdateRequest): Promise<TagUpdateResult> {
    if (this.#saving) throw { code: "busy", message: "Tag save already in progress" };
    this.#saving = true;
    ++this.#generation;
    try {
      const result = await this.io.update(request);
      this.io.changed(result.snapshot);
      return result;
    } finally {
      this.#saving = false;
      if (this.#reloadOwed) {
        this.#reloadOwed = false;
        await this.reload();
      }
    }
  }
}
