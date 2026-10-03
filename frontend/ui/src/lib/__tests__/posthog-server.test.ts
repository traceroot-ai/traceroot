import { beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.fn();
const clientEnv: Record<string, string | undefined> = {};

vi.mock("posthog-node", () => ({
  PostHog: class {
    capture = capture;
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
});
