import { LOCALE_COOKIE, type Locale } from "./locales";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Remembers the language in a cookie. It holds nothing but the language code, so it is readable
 * by script; the server reads it to render the next page in that language.
 */
export function storeLocale(locale: Locale) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax${secure}`;
}
