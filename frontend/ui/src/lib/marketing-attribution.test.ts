import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_MAX_AGE_SECONDS,
  attributionPersonProperties,
  attributionProperties,
  encodeAttributionCookie,
  getUtmParams,
  readAttributionCookie,
} from "./marketing-attribution";

const now = Date.now();
function cookie(value: unknown) {
  return `${ATTRIBUTION_COOKIE}=${encodeURIComponent(JSON.stringify(value))}`;
}

describe("campaign input", () => {
  it("only accepts bounded standard UTMs, never auth parameters", () => {
    expect(
      getUtmParams(
        new URLSearchParams({
          utm_source: "github",
          utm_content: "组织首页",
          utm_medium: "x".repeat(201),
          utm_campaign: "bad\nvalue",
          token: "secret",
          callbackUrl: "//evil.test",
        }),
      ),
    ).toEqual({ utm_source: "github", utm_content: "组织首页" });
  });

  it("reads only whitelisted campaign metadata from the named cookie", () => {
    expect(
      readAttributionCookie(
        `other=x; ${cookie({ v: 1, capturedAt: now, utm: { utm_source: "github", token: "secret" } })}; session=secret`,
      ),
    ).toEqual({ capturedAt: now, utm: { utm_source: "github" } });
  });

  it.each([
    "traceroot_campaign_v1=%bad",
    "traceroot_campaign_v1=" + "x".repeat(3501),
    cookie({ v: 2, capturedAt: now, utm: { utm_source: "github" } }),
    cookie({ v: 1, capturedAt: now + 120_000, utm: { utm_source: "github" } }),
    cookie({
      v: 1,
      capturedAt: now - ATTRIBUTION_MAX_AGE_SECONDS * 1000,
      utm: { utm_source: "github" },
    }),
    cookie({ v: 1, capturedAt: now, utm: { utm_source: { nested: true } } }),
    cookie({ v: 1, capturedAt: 8_640_000_000_000_001, utm: { utm_source: "github" } }),
  ])("ignores malformed, oversized, future or expired metadata", (header) => {
    expect(readAttributionCookie(header, now)).toBeNull();
  });
});

describe("campaign properties", () => {
  it("uses the same field validation for URLs and cookies", () => {
    const utm = { utm_source: " github ", utm_medium: "x".repeat(201), token: "secret" };
    expect(readAttributionCookie(cookie({ v: 1, capturedAt: now, utm }))?.utm).toEqual(
      getUtmParams(new URLSearchParams(utm)),
    );
  });

  it("round-trips the bounded cookie and leaves malformed input empty", () => {
    const attribution = { capturedAt: now, utm: { utm_source: "github" } };
    expect(
      readAttributionCookie(
        `${ATTRIBUTION_COOKIE}=${encodeURIComponent(encodeAttributionCookie(attribution)!)}`,
      ),
    ).toEqual(attribution);
    expect(readAttributionCookie(null)).toBeNull();
    expect(attributionProperties(null)).toEqual({});
    expect(attributionPersonProperties(null)).toEqual({});
    expect(
      encodeAttributionCookie({ capturedAt: now, utm: { utm_source: "测".repeat(1000) } }),
    ).toBeNull();
  });

  it("replaces partial campaign fields without overwriting PostHog first touch", () => {
    const attribution = { capturedAt: now, utm: { utm_source: "github" } };
    expect(attributionProperties(attribution)).toEqual({
      utm_source: "github",
      marketing_touch_at: new Date(now).toISOString(),
      marketing_attribution_model: "last_campaign_touch",
    });
    expect(attributionPersonProperties(attribution)).toEqual({
      ...attributionProperties(attribution),
      utm_medium: null,
      utm_campaign: null,
      utm_content: null,
      utm_term: null,
    });
  });
});
