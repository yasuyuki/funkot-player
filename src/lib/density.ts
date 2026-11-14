export const DENSITY_STORAGE_KEY = "funkot-player:density-preference";

export type DensityPreference = "auto" | "mouse" | "touch";

export interface DensityRoot {
  dataset: { density?: string };
}

export function parseDensityPreference(value: unknown): DensityPreference {
  return value === "mouse" || value === "touch" ? value : "auto";
}

export function readDensityPreference(storage: Pick<Storage, "getItem"> | null): DensityPreference {
  try {
    return parseDensityPreference(storage?.getItem(DENSITY_STORAGE_KEY));
  } catch {
    return "auto";
  }
}

export function applyDensity(root: DensityRoot, preference: DensityPreference): void {
  if (preference === "auto") delete root.dataset.density;
  else root.dataset.density = preference;
}

export function saveDensityPreference(
  root: DensityRoot,
  storage: Pick<Storage, "setItem"> | null,
  preference: DensityPreference,
): void {
  try {
    storage?.setItem(DENSITY_STORAGE_KEY, preference);
  } catch {
  }
  applyDensity(root, preference);
}

export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
