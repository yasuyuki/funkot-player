import type { TagTarget, TrackTagState } from "./tauri";

export interface TagEditorSession {
  targets: TagTarget[];
  revision: string;
  title: string;
  initialStates: TrackTagState[];
  opener: HTMLElement | null;
}

class TagEditorController {
  current = $state<TagEditorSession | null>(null);
  open(session: TagEditorSession): void {
    // The editor must not observe mutable store proxies as its opening state.
    this.current = {
      ...session,
      targets: JSON.parse(JSON.stringify(session.targets)),
      initialStates: JSON.parse(JSON.stringify(session.initialStates)),
      opener: session.opener,
    };
  }
  close = (): void => { this.current = null; };
}
export const tagEditorSession = new TagEditorController();
