import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signupAttributionProperties } from "./attribution";

const capturedAt = Date.parse("2026-10-13T02:00:00Z");
const utm = {
  utm_source: "github",
  utm_medium: "referral",
  utm_campaign: "github-navigation",
  utm_content: "readme-cloud-en",
};
const cookie = `traceroot_campaign_v1=${encodeURIComponent(JSON.stringify({ v: 1, capturedAt, utm }))}`;
const expected = {
  ...utm,
  marketing_touch_at: new Date(capturedAt).toISOString(),
  marketing_attribution_model: "last_campaign_touch",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(capturedAt + 60_000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("signupAttributionProperties", () => {
  it.each(["/sign-up/email", "/callback/google"])(
    "adds the campaign to a new user created through %s",
    (path) => {
      expect(signupAttributionProperties({ path, headers: new Headers({ cookie }) })).toEqual(
        expected,
      );
    },
  );

  it("also reads cookies from the request when context headers are absent", () => {
    const request = new Request("https://app.traceroot.ai/api/auth/callback/google", {
      headers: { cookie },
    });
    expect(signupAttributionProperties({ path: "/callback/google", request })).toEqual(expected);
  });

  it.each([null, undefined, { path: "/sign-up/email" }])(
    "leaves attribution empty when there is no request cookie: %j",
    (context) => {
      expect(signupAttributionProperties(context)).toEqual({});
    },
  );

  it("does not assign an admin's campaign to the user they create", () => {
    expect(
      signupAttributionProperties({ path: "/admin/create-user", headers: new Headers({ cookie }) }),
    ).toEqual({});
  });

  it("does not allow a headers failure to fail registration", () => {
    const headers = new Headers();
    vi.spyOn(headers, "get").mockImplementation(() => {
      throw new Error("unavailable headers");
    });
    expect(signupAttributionProperties({ path: "/sign-up/email", headers })).toEqual({});
  });
});
