// Campaign metadata is untrusted analytics input, never an authentication signal.
// Keep it host-only: website-to-Cloud identity sharing is managed by PostHog.
export const ATTRIBUTION_COOKIE = "traceroot_campaign_v1";
export const ATTRIBUTION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const MAX_VALUE_LENGTH = 200;
export const ATTRIBUTION_MAX_COOKIE_LENGTH = 3500;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

type SearchParams = { get(name: string): string | null };
export type CampaignAttribution = { capturedAt: number; utm: Record<string, string> };

export function getUtmParams(params: SearchParams): Record<string, string> {
  const utm: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const value = params.get(key)?.trim();
    if (
      value &&
      value.length <= MAX_VALUE_LENGTH &&
      !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    ) {
      utm[key] = value;
    }
  }
  return utm;
}

// The caller validates callbackUrl with safeCallbackUrl. UTM parameters live at
// the top level so the analytics SDK can read them before the user signs in.
export function authPageHref(
  path: "/auth/sign-in" | "/auth/sign-up",
  callbackUrl: string,
  params: SearchParams,
): string {
  const query = new URLSearchParams();
  if (callbackUrl && callbackUrl !== "/") query.set("callbackUrl", callbackUrl);
  for (const [key, value] of Object.entries(getUtmParams(params))) query.set(key, value);
  return query.size ? `${path}?${query.toString()}` : path;
}

export function readAttributionCookie(
  cookieHeader: string | null | undefined,
  now = Date.now(),
): CampaignAttribution | null {
  try {
    const entry = cookieHeader
      ?.split(";")
      .find((part) => part.trim().startsWith(`${ATTRIBUTION_COOKIE}=`));
    if (!entry) return null;
    const encoded = entry.trim().slice(ATTRIBUTION_COOKIE.length + 1);
    if (encoded.length > ATTRIBUTION_MAX_COOKIE_LENGTH) return null;
    const value = JSON.parse(decodeURIComponent(encoded));
    if (
      value?.v !== 1 ||
      !Number.isSafeInteger(value.capturedAt) ||
      value.capturedAt <= 0 ||
      value.capturedAt > now + 60_000 ||
      now - value.capturedAt >= ATTRIBUTION_MAX_AGE_SECONDS * 1000 ||
      !value.utm ||
      typeof value.utm !== "object" ||
      Array.isArray(value.utm)
    )
      return null;
    const utm = getUtmParams({
      get: (key) => (typeof value.utm[key] === "string" ? value.utm[key] : null),
    });
    return Object.keys(utm).length ? { capturedAt: value.capturedAt, utm } : null;
  } catch {
    return null;
  }
}

export function attributionProperties(
  attribution: CampaignAttribution | null,
): Record<string, string> {
  if (!attribution) return {};
  return {
    ...attribution.utm,
    marketing_touch_at: new Date(attribution.capturedAt).toISOString(),
    marketing_attribution_model: "last_campaign_touch",
  };
}

export function attributionPersonProperties(
  attribution: CampaignAttribution | null,
): Record<string, string | null> {
  if (!attribution) return {};
  // A new partial campaign must not inherit missing fields from an older one.
  return {
    ...Object.fromEntries(UTM_KEYS.map((key) => [key, attribution.utm[key] ?? null])),
    ...attributionProperties(attribution),
  };
}
