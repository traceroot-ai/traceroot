import { describe, expect, it } from "vitest";
import type { CaptureResult } from "posthog-js";
import { scrubCaptureResult, scrubUrl } from "./analytics-scrub";

const RESET = "https://app.traceroot.ai/auth/reset-password?token=SECRET123";
const event = (name: string, properties: Record<string, unknown>, extra = {}) =>
  ({ uuid: "u", event: name, properties, ...extra }) as unknown as CaptureResult;

describe("scrubUrl", () => {
  it.each([
    [RESET, "https://app.traceroot.ai/auth/reset-password"],
    [
      "https://app.traceroot.ai/invites/accept?token=abc&utm_source=mail",
      "https://app.traceroot.ai/invites/accept?utm_source=mail",
    ],
    [
      "https://app.traceroot.ai/projects/p1/traces?traceId=t1",
      "https://app.traceroot.ai/projects/p1/traces?traceId=t1",
    ],
    ["/auth/reset-password?token=x", "/auth/reset-password?token=x"],
    ["not a url", "not a url"],
    [42, 42],
  ])("%j → %j", (input, output) => {
    expect(scrubUrl(input)).toBe(output);
  });
});

describe("scrubCaptureResult", () => {
  it("removes the token from a page view on the reset page, and keeps the event", () => {
    const result = scrubCaptureResult(
      event("$pageview", { $current_url: RESET, $pathname: "/auth/reset-password" }),
      RESET,
    );
    expect(result?.event).toBe("$pageview");
    expect(result?.properties).toEqual({
      $current_url: "https://app.traceroot.ai/auth/reset-password",
      $pathname: "/auth/reset-password",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET123");
  });

  it("removes it from page leaves, clicks, the referrer and the person's first URL", () => {
    for (const name of ["$pageleave", "$autocapture", "$pageview"]) {
      const result = scrubCaptureResult(
        event(
          name,
          {
            $current_url: RESET,
            $referrer: RESET,
            $prev_pageview_pathname: "/auth/reset-password",
          },
          { $set_once: { $initial_current_url: RESET, $initial_referrer: RESET } },
        ),
        "https://app.traceroot.ai/auth/sign-in",
      );
      expect(JSON.stringify(result)).not.toContain("SECRET123");
    }
  });

  it("leaves an ordinary event as it was", () => {
    const properties = {
      $current_url: "https://app.traceroot.ai/projects/p1/traces?traceId=t1",
      $referrer: "https://www.google.com/",
      plan: "free",
    };
    const result = scrubCaptureResult(event("$pageview", { ...properties }));
    expect(result?.properties).toEqual(properties);
  });

  it("does not send replay snapshots taken while the address bar holds a token", () => {
    expect(scrubCaptureResult(event("$snapshot", { $snapshot_data: [] }), RESET)).toBeNull();
  });

  it("sends replay snapshots on other pages", () => {
    const snapshot = event("$snapshot", { $snapshot_data: [] });
    expect(scrubCaptureResult(snapshot, "https://app.traceroot.ai/workspaces")).toBe(snapshot);
  });

  it("passes on a dropped event", () => {
    expect(scrubCaptureResult(null)).toBeNull();
  });
});
