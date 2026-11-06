import { ATTRIBUTION_COOKIE, readAttributionCookie } from "./marketing-attribution";

export function clearBrowserAttribution(): void {
  try {
    document.cookie = `${ATTRIBUTION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  } catch {
    // Optional analytics storage must never break authentication.
  }
}

export function readBrowserAttribution() {
  try {
    return readAttributionCookie(document.cookie);
  } catch {
    return null;
  }
}
