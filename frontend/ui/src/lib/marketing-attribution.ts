import { z } from "zod";

// Campaign metadata is untrusted analytics input, never an authentication signal.
// Keep it host-only: website-to-Cloud identity sharing is managed by PostHog.
export const ATTRIBUTION_COOKIE = "traceroot_campaign_v1";
export const ATTRIBUTION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const ATTRIBUTION_MAX_COOKIE_LENGTH = 3500;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

const utmField = z
  .string()
  .trim()
  .min(1)
  .max(200)
  // eslint-disable-next-line no-control-regex -- reject control characters in untrusted metadata
  .regex(/^[^\x00-\x1f\x7f]*$/)
  .optional()
  .catch(undefined);
const utmSchema = z
  .object({
    utm_source: utmField,
    utm_medium: utmField,
    utm_campaign: utmField,
    utm_content: utmField,
    utm_term: utmField,
  })
  .transform((fields) =>
    Object.fromEntries(
      Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  );
const cookieSchema = z.object({
  v: z.literal(1),
  capturedAt: z.number().int().positive().max(8_640_000_000_000_000),
  utm: utmSchema.refine((utm) => Object.keys(utm).length > 0),
});
export type CampaignAttribution = { capturedAt: number; utm: Record<string, string> };

export function getUtmParams(params: URLSearchParams): Record<string, string> {
  return utmSchema.parse(Object.fromEntries(UTM_KEYS.map((key) => [key, params.get(key)])));
}

export function encodeAttributionCookie(attribution: CampaignAttribution): string | null {
  // NextResponse.cookies.set handles URI encoding on the wire.
  const value = JSON.stringify({ v: 1, ...attribution });
  return encodeURIComponent(value).length <= ATTRIBUTION_MAX_COOKIE_LENGTH ? value : null;
}

export function readAttributionCookie(
  cookieHeader: string | null | undefined,
  now?: number,
): CampaignAttribution | null {
  try {
    const entry = cookieHeader
      ?.split(";")
      .find((part) => part.trim().startsWith(`${ATTRIBUTION_COOKIE}=`));
    if (!entry) return null;
    const encoded = entry.trim().slice(ATTRIBUTION_COOKIE.length + 1);
    if (encoded.length > ATTRIBUTION_MAX_COOKIE_LENGTH) return null;
    const parsed = cookieSchema.safeParse(JSON.parse(decodeURIComponent(encoded)));
    if (!parsed.success) return null;
    const { capturedAt, utm } = parsed.data;
    // Validate age using the server clock. Browsers rely on cookie Max-Age so
    // a skewed device clock cannot discard a valid server timestamp.
    if (
      now !== undefined &&
      (capturedAt > now + 60_000 || now - capturedAt >= ATTRIBUTION_MAX_AGE_SECONDS * 1000)
    )
      return null;
    return { capturedAt, utm };
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
