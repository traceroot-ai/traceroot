import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("captures an event that happened earlier at the time it happened", async () => {
    const { captureServerEvent } = await import("../posthog-server");
    const receivedAt = new Date("2026-11-18T10:30:00Z");
    captureServerEvent("user-1", "first_trace_received", { project_id: "p1" }, receivedAt);
    expect(capture).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: "first_trace_received",
      properties: { project_id: "p1" },
      timestamp: receivedAt,
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
  const fetchMock = vi.fn();
  const sentBodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));

  beforeEach(() => {
    vi.resetModules();
    captureImmediate.mockReset();
    fetchMock.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    clientEnv.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    clientEnv.NEXT_PUBLIC_POSTHOG_HOST = "https://us.i.posthog.com/";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does nothing without a key", async () => {
    clientEnv.NEXT_PUBLIC_POSTHOG_KEY = undefined;
    const { sendServerPersonProperties } = await import("../posthog-server");
    await sendServerPersonProperties("user-1", { trace_count: 3 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips impersonated requests", async () => {
    const { sendServerPersonProperties } = await import("../posthog-server");
    const { supportRequest } = await import("@/lib/support/request-context");
    await supportRequest.run({ session: null, impersonation: {} as never }, () =>
      sendServerPersonProperties("user-1", { trace_count: 3 }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the properties as their own $set request and resolves once PostHog accepts", async () => {
    const { sendServerPersonProperties } = await import("../posthog-server");
    await sendServerPersonProperties("user-1", { trace_count: 3 });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://us.i.posthog.com/batch/");
    expect(init.method).toBe("POST");
    expect(sentBodies()[0]).toMatchObject({
      api_key: "phc_test",
      batch: [
        {
          event: "$set",
          distinct_id: "user-1",
          properties: { $set: { trace_count: 3 }, $geoip_disable: true },
        },
      ],
    });
    // Not through the shared client, whose failures cannot be told apart.
    expect(captureImmediate).not.toHaveBeenCalled();
  });

  it("rejects when PostHog answers with an error", async () => {
    fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));
    const { sendServerPersonProperties } = await import("../posthog-server");
    await expect(sendServerPersonProperties("user-1", { trace_count: 3 })).rejects.toThrow(
      "PostHog answered 503",
    );
  });

  it("rejects when PostHog cannot be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const { sendServerPersonProperties } = await import("../posthog-server");
    await expect(sendServerPersonProperties("user-1", { trace_count: 3 })).rejects.toThrow(
      "fetch failed",
    );
  });

  it("gives each send the answer to its own request", async () => {
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const userId = JSON.parse(init.body).batch[0].distinct_id;
      return new Response("", { status: userId === "user-bad" ? 400 : 200 });
    });
    const { sendServerPersonProperties } = await import("../posthog-server");

    const [bad, good] = await Promise.allSettled([
      sendServerPersonProperties("user-bad", { trace_count: 1 }),
      sendServerPersonProperties("user-good", { trace_count: 2 }),
    ]);
    expect(bad.status).toBe("rejected");
    expect(good.status).toBe("fulfilled");
  });

  it("cancels the request when the caller's signal aborts", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener("abort", () => reject(init.signal.reason)),
        ),
    );
    const { sendServerPersonProperties } = await import("../posthog-server");
    const controller = new AbortController();
    const sending = sendServerPersonProperties(
      "user-1",
      { trace_count: 3 },
      { signal: controller.signal },
    );
    controller.abort(new Error("out of time"));
    await expect(sending).rejects.toThrow("out of time");
  });
});
