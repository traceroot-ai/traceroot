import { beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.fn();
const captureImmediate = vi.fn();
const clientEnv: Record<string, string | undefined> = {};

vi.mock("posthog-node", () => ({
  PostHog: class {
    capture = capture;
    captureImmediate = captureImmediate;
    on = vi.fn();
  },
}));

vi.mock("@/env.client", () => ({ clientEnv }));

describe("captureServerEvent", () => {
  beforeEach(() => {
    vi.resetModules();
    capture.mockReset();
    clientEnv.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    clientEnv.NEXT_PUBLIC_POSTHOG_HOST = "https://us.i.posthog.com";
  });

  it("does nothing without a key", async () => {
    clientEnv.NEXT_PUBLIC_POSTHOG_KEY = undefined;
    const { captureServerEvent } = await import("../posthog-server");
    captureServerEvent("user-1", "project_created");
    expect(capture).not.toHaveBeenCalled();
  });

  it("skips impersonated requests", async () => {
    const { captureServerEvent } = await import("../posthog-server");
    const { supportRequest } = await import("@/lib/support/request-context");
    supportRequest.run({ session: null, impersonation: {} as never }, () =>
      captureServerEvent("user-1", "project_created"),
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures the event with distinctId and properties", async () => {
    const { captureServerEvent } = await import("../posthog-server");
    captureServerEvent("user-1", "project_created", { project_id: "p1" });
    expect(capture).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: "project_created",
      properties: { project_id: "p1" },
    });
  });

  it("logs and swallows a capture error", async () => {
    capture.mockImplementation(() => {
      throw new Error("boom");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { captureServerEvent } = await import("../posthog-server");
    expect(() => captureServerEvent("user-1", "project_created")).not.toThrow();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("isServerAnalyticsEnabled", () => {
  beforeEach(() => {
    vi.resetModules();
    clientEnv.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    clientEnv.NEXT_PUBLIC_POSTHOG_HOST = "https://us.i.posthog.com";
  });

  it("is false without a key", async () => {
    clientEnv.NEXT_PUBLIC_POSTHOG_KEY = undefined;
    const { isServerAnalyticsEnabled } = await import("../posthog-server");
    expect(isServerAnalyticsEnabled()).toBe(false);
  });

  it("is true with a key and host", async () => {
    const { isServerAnalyticsEnabled } = await import("../posthog-server");
    expect(isServerAnalyticsEnabled()).toBe(true);
  });
});

describe("sendServerPersonProperties", () => {
  beforeEach(() => {
    vi.resetModules();
    captureImmediate.mockReset();
    captureImmediate.mockResolvedValue(undefined);
    clientEnv.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    clientEnv.NEXT_PUBLIC_POSTHOG_HOST = "https://us.i.posthog.com";
  });

  it("does nothing without a key", async () => {
    clientEnv.NEXT_PUBLIC_POSTHOG_KEY = undefined;
    const { sendServerPersonProperties } = await import("../posthog-server");
    await sendServerPersonProperties("user-1", { trace_count: 3 });
    expect(captureImmediate).not.toHaveBeenCalled();
  });

  it("skips impersonated requests", async () => {
    const { sendServerPersonProperties } = await import("../posthog-server");
    const { supportRequest } = await import("@/lib/support/request-context");
    await supportRequest.run({ session: null, impersonation: {} as never }, () =>
      sendServerPersonProperties("user-1", { trace_count: 3 }),
    );
    expect(captureImmediate).not.toHaveBeenCalled();
  });

  it("sets the properties on the person and waits until PostHog has them", async () => {
    let accept: () => void = () => {};
    captureImmediate.mockReturnValue(new Promise<void>((resolve) => (accept = resolve)));
    const { sendServerPersonProperties } = await import("../posthog-server");
    let settled = false;
    const sending = sendServerPersonProperties("user-1", { trace_count: 3 }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(captureImmediate).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: "$set",
      properties: { $set: { trace_count: 3 } },
    });
    expect(settled).toBe(false);
    accept();
    await sending;
    expect(settled).toBe(true);
  });

  it("rejects when PostHog does not accept the properties", async () => {
    captureImmediate.mockRejectedValue(new Error("503"));
    const { sendServerPersonProperties } = await import("../posthog-server");
    await expect(sendServerPersonProperties("user-1", { trace_count: 3 })).rejects.toThrow("503");
  });
});
