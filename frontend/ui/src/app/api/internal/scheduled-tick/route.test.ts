import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

const reportDailyTraceCountsMock = vi.fn();
vi.mock("@/lib/trace-count", () => ({
  reportDailyTraceCounts: (...args: unknown[]) => reportDailyTraceCountsMock(...args),
}));

const runFollowUpsMock = vi.fn();
vi.mock("@/lib/lifecycle/follow-up-job", () => ({
  runFollowUps: (...args: unknown[]) => runFollowUpsMock(...args),
}));

const order: string[] = [];
const runWelcomeFallbackMock = vi.fn();
vi.mock("@/lib/email/welcome/welcome-schedule", () => ({
  runWelcomeFallback: (...args: unknown[]) => {
    order.push("welcome");
    return runWelcomeFallbackMock(...args);
  },
}));

const syncPendingEmailPreferencesMock = vi.fn();
vi.mock("@/lib/lifecycle/email-preference-sync", () => ({
  syncPendingEmailPreferences: (...args: unknown[]) => syncPendingEmailPreferencesMock(...args),
}));

import { POST } from "./route";

const tick = () => POST({} as Parameters<typeof POST>[0]);

beforeEach(() => {
  syncPendingEmailPreferencesMock.mockReset().mockResolvedValue({ synced: 0, pending: 0 });
  verifyInternalSecretMock.mockReset().mockReturnValue(true);
  reportDailyTraceCountsMock.mockReset().mockResolvedValue({ kind: "sent", sent: 2, remaining: 0 });
  runFollowUpsMock.mockReset().mockImplementation(async () => {
    order.push("follow-ups");
    return { mode: "off" };
  });
  runWelcomeFallbackMock.mockReset().mockResolvedValue({ due: 1, sent: 1 });
  order.length = 0;
});

describe("POST /api/internal/scheduled-tick", () => {
  it("runs the daily trace counts and reports what it did", async () => {
    const response = await tick();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      traceCounts: { kind: "sent", sent: 2, remaining: 0 },
      welcomes: { due: 1, sent: 1 },
      followUps: { mode: "off" },
      emailPreferences: { synced: 0, pending: 0 },
    });
    expect(reportDailyTraceCountsMock).toHaveBeenCalledTimes(1);
    // The welcome goes first: the follow-ups only go to people who have had it.
    expect(order).toEqual(["welcome", "follow-ups"]);
  });

  it("still runs the follow-ups when the welcome run fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    runWelcomeFallbackMock.mockRejectedValue(new Error("db down"));
    const body = await (await tick()).json();
    expect(body.welcomes).toEqual({ error: "failed" });
    expect(body.followUps).toEqual({ mode: "off" });
  });

  it("still answers, with the trace counts, when the follow-ups fail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    runFollowUpsMock.mockRejectedValue(new Error("db down"));
    const response = await tick();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      traceCounts: { kind: "sent", sent: 2, remaining: 0 },
      welcomes: { due: 1, sent: 1 },
      followUps: { error: "failed" },
      emailPreferences: { synced: 0, pending: 0 },
    });
  });

  it("still runs the email tasks, and answers, when the trace report rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    reportDailyTraceCountsMock.mockRejectedValue(new Error("posthog down"));
    runFollowUpsMock.mockResolvedValue({ mode: "send", sent: 1 });

    const response = await tick();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      traceCounts: { error: "failed" },
      welcomes: { due: 1, sent: 1 },
      followUps: { mode: "send", sent: 1 },
      emailPreferences: { synced: 0, pending: 0 },
    });
    expect(runWelcomeFallbackMock).toHaveBeenCalledTimes(1);
    expect(runFollowUpsMock).toHaveBeenCalledTimes(1);
  });

  it("answers with every failure when every task rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    reportDailyTraceCountsMock.mockRejectedValue(new Error("posthog down"));
    runWelcomeFallbackMock.mockRejectedValue(new Error("db down"));
    runFollowUpsMock.mockRejectedValue(new Error("db down"));

    const response = await tick();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      traceCounts: { error: "failed" },
      welcomes: { error: "failed" },
      followUps: { error: "failed" },
      emailPreferences: { synced: 0, pending: 0 },
    });
  });

  it("rejects a caller without the internal secret before doing any work", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const response = await tick();

    expect(response.status).toBe(401);
    expect(reportDailyTraceCountsMock).not.toHaveBeenCalled();
    expect(runFollowUpsMock).not.toHaveBeenCalled();
    expect(runWelcomeFallbackMock).not.toHaveBeenCalled();
  });

  it("finishes the email-preference syncs, and still answers when that fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    syncPendingEmailPreferencesMock.mockResolvedValueOnce({ synced: 2, pending: 1 });
    expect((await (await tick()).json()).emailPreferences).toEqual({ synced: 2, pending: 1 });
    syncPendingEmailPreferencesMock.mockRejectedValueOnce(new Error("db down"));
    const response = await tick();
    expect(response.status).toBe(200);
    expect((await response.json()).emailPreferences).toEqual({ error: "failed" });
  });
});
