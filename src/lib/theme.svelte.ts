export const THEME_STORAGE_KEY = "funkot-player:theme-preference";

const THEME_PREFERENCES = ["dark", "light", "system"] as const;

type ThemePreference = (typeof THEME_PREFERENCES)[number];
type ResolvedTheme = Exclude<ThemePreference, "system">;

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ThemeRoot {
  dataset: { theme?: string };
  classList: { toggle(name: string, force?: boolean): boolean };
  style: { colorScheme: string };
}

export interface ColorSchemeMedia {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
}

export interface ThemeController {
  readonly preference: ThemePreference;
  setPreference(preference: ThemePreference): void;
}

interface ThemeOptions {
  root: ThemeRoot;
  storage: ThemeStorage | null;
  colorSchemeMedia: ColorSchemeMedia;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "dark" || value === "light" || value === "system";
}

export function parseThemePreference(value: unknown): ThemePreference {
  return isThemePreference(value) ? value : "dark";
}

export function resolveTheme(preference: ThemePreference, systemIsDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemIsDark ? "dark" : "light") : preference;
}

export function readThemePreference(storage: Pick<ThemeStorage, "getItem"> | null): ThemePreference {
  try {
    return parseThemePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
}

export function applyTheme(root: ThemeRoot, theme: ResolvedTheme): void {
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

class BrowserThemeController implements ThemeController {
  preference: ThemePreference;

  constructor(private readonly options: ThemeOptions) {
    this.preference = readThemePreference(options.storage);
    this.apply();
    options.colorSchemeMedia.addEventListener("change", this.onSystemThemeChange);
  }

  setPreference(preference: ThemePreference): void {
    this.preference = preference;
    try {
      this.options.storage?.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // A blocked storage write must not prevent the listener from using this choice now.
    }
    this.apply();
  }

  private readonly onSystemThemeChange = (): void => {
    if (this.preference === "system") {
      this.apply();
    }
  };

  private apply(): void {
    applyTheme(
      this.options.root,
      resolveTheme(this.preference, this.options.colorSchemeMedia.matches),
    );
  }
}

export function createThemeController(options: ThemeOptions): ThemeController {
  return new BrowserThemeController(options);
}

let activeThemeController: ThemeController | undefined;

function browserStorage(): ThemeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function initializeTheme(): ThemeController {
  if (!activeThemeController) {
    activeThemeController = createThemeController({
      root: document.documentElement,
      storage: browserStorage(),
      colorSchemeMedia: window.matchMedia("(prefers-color-scheme: dark)"),
    });
  }
  return activeThemeController;
}

export function getThemeController(): ThemeController {
  if (!activeThemeController) {
    throw new Error("Theme must be initialized before use");
  }
  return activeThemeController;
}
