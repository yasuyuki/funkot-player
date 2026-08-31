// Locale identity and detection. Deliberately rune-free (a plain `.ts`, not
// `.svelte.ts`) so `locale.test.mjs` can import it through esbuild the same
// way `arrivals.test.mjs` imports `arrivals.ts`. The reactive current-locale
// store lives in `i18n.svelte.ts`.

/// Supported UI languages. `en` is first because it is the fallback for any
/// tag that is not Japanese or Indonesian.
export const LOCALES = ["en", "ja", "id"] as const;

export type Locale = (typeof LOCALES)[number];

/// Shown in the ⋮ menu. Each language is named in its own script, never
/// translated into the language currently on screen -- someone looking for
/// their own language has to be able to recognise it without already reading
/// the one that is up.
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  ja: "日本語",
  id: "Bahasa Indonesia",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/// BCP-47 tag (`navigator.language`, or whatever `settings.json` holds) → a
/// supported locale. Anything unrecognised falls back to `en`.
export function detectLocale(tag: string | null | undefined): Locale {
  const base = (tag ?? "").toLowerCase().split(/[-_]/)[0];
  if (base === "ja") return "ja";
  // `in` is Indonesian's superseded ISO 639-1 code. Java's `Locale` still
  // normalises `id` to it, so an Android WebView can hand us either one.
  if (base === "id" || base === "in") return "id";
  return "en";
}

/// Next locale in `LOCALES` order, wrapping. The ⋮ menu item cycles rather
/// than opening a submenu -- same shape as the other toggles there.
export function nextLocale(current: Locale): Locale {
  const i = LOCALES.indexOf(current);
  return LOCALES[(i + 1) % LOCALES.length];
}
