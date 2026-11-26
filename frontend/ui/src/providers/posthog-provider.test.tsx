// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { CaptureResult } from "posthog-js";

const init = vi.hoisted(() => vi.fn());
vi.mock("posthog-js", () => ({ default: { init } }));
vi.mock("posthog-js/react", () => ({ PostHogProvider: () => null }));

describe("the browser analytics client", () => {
  it("is set up to scrub secret query parameters from every event it sends", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://ph.example");
    await import("./posthog-provider");

    expect(init).toHaveBeenCalledOnce();
    const config = init.mock.calls[0][1];
    // Ordinary tracking stays as it was.
    expect(config).toMatchObject({ capture_pageview: false, capture_pageleave: true });
    const sent = config.before_send({
      uuid: "u",
      event: "$pageview",
      properties: { $current_url: "https://app.example/auth/reset-password?token=SECRET123" },
    } as unknown as CaptureResult);
    expect(JSON.stringify(sent)).not.toContain("SECRET123");
    expect(sent.event).toBe("$pageview");
  });
});
