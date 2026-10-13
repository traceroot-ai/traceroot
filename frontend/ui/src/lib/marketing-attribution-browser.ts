import posthog from "posthog-js";
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_MAX_AGE_SECONDS,
  ATTRIBUTION_MAX_COOKIE_LENGTH,
  type CampaignAttribution,
  getUtmParams,
  readAttributionCookie,
} from "./marketing-attribution";

let lastLanding: string | null = null;

export function clearBrowserAttribution(): void {
  try {
    document.cookie = `${ATTRIBUTION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  } catch {
    // Optional analytics storage must never break authentication.
  }
}

// De-duplicate captures on the same page, not repeat campaign visits on another
// day. A new document load starts a new touch; ordinary navigation never does.
export function captureBrowserAttribution(force = false): CampaignAttribution | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY || !process.env.NEXT_PUBLIC_POSTHOG_HOST) return null;
  try {
    if (posthog.has_opted_out_capturing()) {
      clearBrowserAttribution();
      lastLanding = null;
      return null;
    }
    const previous = readAttributionCookie(document.cookie);
    const utm = getUtmParams(new URLSearchParams(window.location.search));
    if (!Object.keys(utm).length) {
      lastLanding = null;
      return previous;
    }
    const landing = window.location.pathname + JSON.stringify(utm);
    if (!force && lastLanding === landing) return previous;
    const attribution = { capturedAt: Date.now(), utm };
    const encoded = encodeURIComponent(JSON.stringify({ v: 1, ...attribution }));
    if (encoded.length > ATTRIBUTION_MAX_COOKIE_LENGTH) return previous;
    document.cookie = `${ATTRIBUTION_COOKIE}=${encoded}; Path=/; Max-Age=${ATTRIBUTION_MAX_AGE_SECONDS}; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;
    lastLanding = landing;
    return attribution;
  } catch {
    return null;
  }
}
