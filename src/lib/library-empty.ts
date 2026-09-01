import type { LibraryScanProgress } from "./tauri";

/// Whether the library pane should show the "no tracks" empty copy.
///
/// `refresh_library` replaces `libraryList` only after the whole walk+hash
/// finishes, so an empty list during a scan does not mean the folder is empty.
/// The first `library-scan` event is always `walking` with `found: 0`; hashing
/// is the first time `found` is the real count. Hide the empty copy for the
/// whole in-flight scan, not only after `found >= 1`.
export function showLibraryEmpty(
  listLength: number,
  musicDirNeeded: boolean,
  scan: LibraryScanProgress | null,
): boolean {
  if (musicDirNeeded) return false;
  if (scan !== null) return false;
  return listLength === 0;
}
