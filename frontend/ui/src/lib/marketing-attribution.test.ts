// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_MAX_AGE_SECONDS,
  attributionPersonProperties,
  attributionProperties,
  getUtmParams,
  readAttributionCookie,
} from "./marketing-attribution";

import {
  captureBrowserAttribution,
  clearBrowserAttribution,
} from "./marketing-attribution-browser";

const optedOut = vi.hoisted(() => vi.fn(() => false));
vi.mock("posthog-js", () => ({ default: { has_opted_out_capturing: optedOut } }));

const now = new Date("2026-10-13T08:00:00Z").getTime();
function cookie(value: unknown) {
  return `${ATTRIBUTION_COOKIE}=${encodeURIComponent(JSON.stringify(value))}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://us.i.posthog.com");
  document.cookie = `${ATTRIBUTION_COOKIE}=; Max-Age=0; Path=/`;
  window.history.replaceState({}, "", "/");
  optedOut.mockReturnValue(false);
  captureBrowserAttribution();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

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
  ])("ignores malformed, oversized, future or expired metadata", (header) => {
    expect(readAttributionCookie(header)).toBeNull();
  });
});

describe("browser campaign persistence", () => {
  it("keeps campaign through internal navigation and an OAuth-style return", () => {
    window.history.replaceState(
      {},
      "",
      "/auth/sign-in?utm_source=github&utm_campaign=github-navigation&utm_content=readme-cloud-en",
    );
    const initial = captureBrowserAttribution();
    window.history.replaceState({}, "", "/onboarding");
    vi.setSystemTime(now + 300_000);
    expect(captureBrowserAttribution()).toEqual(initial);
    expect(attributionProperties(readAttributionCookie(document.cookie))).toMatchObject({
      utm_source: "github",
      utm_campaign: "github-navigation",
      utm_content: "readme-cloud-en",
      marketing_attribution_model: "last_campaign_touch",
      marketing_touch_at: new Date(now).toISOString(),
    });
  });

  it("keeps a fixed window on rerenders, but replaces a campaign as a whole", () => {
    window.history.replaceState({}, "", "/auth/sign-in?utm_source=github&utm_content=readme");
    const first = captureBrowserAttribution();
    vi.setSystemTime(now + 5000);
    expect(captureBrowserAttribution()).toEqual(first);
    window.history.replaceState({}, "", "/auth/sign-up?utm_source=linkedin");
    const latest = captureBrowserAttribution();
    expect(latest).toEqual({ capturedAt: now + 5000, utm: { utm_source: "linkedin" } });
    expect(attributionPersonProperties(latest)).toMatchObject({
      utm_source: "linkedin",
      utm_content: null,
      utm_campaign: null,
    });
    expect(
      Object.keys(attributionPersonProperties(latest)).some((key) => key.startsWith("$initial")),
    ).toBe(false);
  });

  it("refreshes attribution when the same campaign is visited again", () => {
    window.history.replaceState({}, "", "/?utm_source=github");
    captureBrowserAttribution();
    window.history.replaceState({}, "", "/onboarding");
    captureBrowserAttribution();
    vi.setSystemTime(now + 29 * 24 * 60 * 60 * 1000);
    window.history.replaceState({}, "", "/?utm_source=github");
    expect(captureBrowserAttribution()?.capturedAt).toBe(Date.now());
    vi.setSystemTime(now + 31 * 24 * 60 * 60 * 1000);
    expect(readAttributionCookie(document.cookie)?.utm.utm_source).toBe("github");
  });

  it("clears campaign storage on opt-out", () => {
    window.history.replaceState({}, "", "/?utm_source=github");
    captureBrowserAttribution();
    optedOut.mockReturnValue(true);
    expect(captureBrowserAttribution()).toBeNull();
    expect(readAttributionCookie(document.cookie)).toBeNull();
  });

  it("does not recreate a consumed campaign on the same page", () => {
    window.history.replaceState({}, "", "/?utm_source=github");
    captureBrowserAttribution();
    clearBrowserAttribution();
    expect(captureBrowserAttribution()).toBeNull();
  });

  it("does not track when analytics is not configured", () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    window.history.replaceState({}, "", "/?utm_source=github");
    expect(captureBrowserAttribution()).toBeNull();
    expect(document.cookie).not.toContain(ATTRIBUTION_COOKIE);
  });

  it("does not break auth when browser storage is blocked", () => {
    vi.spyOn(document, "cookie", "get").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(captureBrowserAttribution()).toBeNull();
  });

  it("keeps the cookie host-only and bounded for Unicode input", () => {
    const setter = vi.spyOn(document, "cookie", "set");
    window.history.replaceState({}, "", "/?utm_source=github");
    captureBrowserAttribution();
    expect(setter.mock.calls[0][0]).toContain("SameSite=Lax");
    expect(setter.mock.calls[0][0]).not.toContain("Domain=");
    // Unicode can inflate after encoding even when every individual field fits.
    const query = new URLSearchParams(
      Object.fromEntries(
        ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].map((k) => [
          k,
          "测".repeat(200),
        ]),
      ),
    );
    window.history.replaceState({}, "", `/?${query}`);
    expect(captureBrowserAttribution()?.utm).toEqual({ utm_source: "github" });
    expect(setter).toHaveBeenCalledTimes(1);
  });
});
