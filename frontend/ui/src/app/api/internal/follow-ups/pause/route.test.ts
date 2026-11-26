import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const env = vi.hoisted(() => ({ LIFECYCLE_PAUSE_SECRET: "pause-secret" }));
vi.mock("@/env", () => ({ env }));
const pause = vi.hoisted(() => ({ setFollowUpPause: vi.fn() }));
vi.mock("@/lib/lifecycle/pause", () => ({
  PAUSE_REASONS: ["outreach", "manual", "conversation"],
  setFollowUpPause: pause.setFollowUpPause,
}));

import { POST } from "./route";

const AT = "2026-12-01T10:00:00.002Z";
const call = (body: unknown, auth: string | null = "Bearer pause-secret") =>
  POST(
    new NextRequest("http://localhost/api/internal/follow-ups/pause", {
      method: "POST",
      body: JSON.stringify(body),
      headers: auth ? { authorization: auth } : {},
    }),
  );

beforeEach(() => {
  env.LIFECYCLE_PAUSE_SECRET = "pause-secret";
  pause.setFollowUpPause.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("POST /api/internal/follow-ups/pause", () => {
  it("passes the decision time on, and answers where the person stands", async () => {
    pause.setFollowUpPause.mockResolvedValue({
      paused: true,
      pauseReason: "conversation",
      unsubscribed: false,
      intentAt: new Date(AT),
      applied: true,
    });
    const res = await call({ userId: "u1", action: "pause", reason: "conversation", intentAt: AT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "u1",
      paused: true,
      pauseReason: "conversation",
      unsubscribed: false,
      intentAt: AT,
      applied: true,
    });
    expect(pause.setFollowUpPause).toHaveBeenCalledWith(
      "u1",
      "pause",
      new Date(AT),
      "conversation",
    );
  });

  it("says when a call was older than the latest applied, with the state that stands", async () => {
    const newer = "2026-12-01T10:00:05.000Z";
    pause.setFollowUpPause.mockResolvedValue({
      paused: false,
      pauseReason: null,
      unsubscribed: true,
      intentAt: new Date(newer),
      applied: false,
    });
    const res = await call({ userId: "u1", action: "resume", intentAt: AT });
    expect(await res.json()).toMatchObject({ unsubscribed: true, applied: false, intentAt: newer });
    expect(pause.setFollowUpPause).toHaveBeenCalledWith("u1", "resume", new Date(AT), undefined);
  });

  it.each([
    ["no credential", null],
    ["the wrong one", "Bearer nope"],
    ["the internal API secret's header form", "pause-secret"],
  ])("refuses %s", async (_what, auth) => {
    expect((await call({ userId: "u1", action: "pause", intentAt: AT }, auth)).status).toBe(401);
    expect(pause.setFollowUpPause).not.toHaveBeenCalled();
  });

  it("is off while no secret is set", async () => {
    env.LIFECYCLE_PAUSE_SECRET = "";
    expect((await call({ userId: "u1", action: "pause", intentAt: AT }, "Bearer ")).status).toBe(
      401,
    );
  });

  it.each([
    [{ userId: "u1", action: "stop" }],
    [{ userId: "u1", action: "pause", reason: "add_to_crm" }],
    [{ action: "pause" }],
    [{ userId: "u1", action: "pause", email: "x@y.z", intentAt: AT }],
    [{ userId: "u1", action: "pause" }],
    [{ userId: "u1", action: "pause", intentAt: "yesterday" }],
  ])("refuses a malformed request %j", async (body) => {
    expect((await call(body)).status).toBe(400);
  });

  it("answers 404 for an unknown user", async () => {
    pause.setFollowUpPause.mockResolvedValue(null);
    expect((await call({ userId: "nobody", action: "pause", intentAt: AT })).status).toBe(404);
  });
});
