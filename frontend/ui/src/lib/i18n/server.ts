import { cookies } from "next/headers";
import { LOCALE_COOKIE, parseLocale, type Locale } from "./locales";

/** The language for this request, from the cookie the language picker writes. */
export async function getRequestLocale(): Promise<Locale> {
  return parseLocale((await cookies()).get(LOCALE_COOKIE)?.value);
}
