// The languages the app can be shown in. Adding one is an entry here (enabled: true) plus a
// file in ./messages; every key it leaves out falls back to English.
export const LOCALES = [
  { code: "en", label: "English", short: "EN", htmlLang: "en", enabled: true },
  { code: "zh", label: "简体中文", short: "中文", htmlLang: "zh-Hans", enabled: true },
  { code: "ja", label: "日本語", short: "日本語", htmlLang: "ja", enabled: false },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];

export const DEFAULT_LOCALE: Locale = "en";

/** Holds the visitor's choice. Read by the server for the first render, written by the picker. */
export const LOCALE_COOKIE = "traceroot_locale";

export const ENABLED_LOCALES = LOCALES.filter((locale) => locale.enabled);

/** A stored or requested value as a language the app can show; anything else is English. */
export function parseLocale(value: string | null | undefined): Locale {
  return ENABLED_LOCALES.find((locale) => locale.code === value)?.code ?? DEFAULT_LOCALE;
}

export function localeInfo(code: Locale) {
  return LOCALES.find((locale) => locale.code === code) ?? LOCALES[0];
}
