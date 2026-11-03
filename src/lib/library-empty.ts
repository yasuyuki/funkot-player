import type { LibraryScanProgress } from "./tauri";

export function showLibraryEmpty(
  listLength: number,
  musicDirNeeded: boolean,
  scan: LibraryScanProgress | null,
): boolean {
  if (musicDirNeeded) return false;
  if (scan !== null) return false;
  return listLength === 0;
}
