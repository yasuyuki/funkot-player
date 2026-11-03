export const LOCALES = ["en", "ja", "id"] as const;

export type Locale = (typeof LOCALES)[number];

export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  ja: "日本語",
  id: "Bahasa Indonesia",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function detectLocale(tag: string | null | undefined): Locale {
  const base = (tag ?? "").toLowerCase().split(/[-_]/)[0];
  if (base === "ja") return "ja";
  // `in` is Indonesian's superseded ISO 639-1 code. Java's `Locale` still
  // normalises `id` to it, so an Android WebView can hand us either one.
  if (base === "id" || base === "in") return "id";
  return "en";
}

export function nextLocale(current: Locale): Locale {
  const i = LOCALES.indexOf(current);
  return LOCALES[(i + 1) % LOCALES.length];
}
