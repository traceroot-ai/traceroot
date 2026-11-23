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
  it("pauses with the reason given, and answers where the person stands", async () => {
    pause.setFollowUpPause.mockResolvedValue({
      paused: true,
      pauseReason: "conversation",
      unsubscribed: false,
    });
    const res = await call({ userId: "u1", action: "pause", reason: "conversation" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "u1",
      paused: true,
      pauseReason: "conversation",
      unsubscribed: false,
    });
    expect(pause.setFollowUpPause).toHaveBeenCalledWith("u1", "pause", "conversation");
  });

  it("resumes", async () => {
    pause.setFollowUpPause.mockResolvedValue({
      paused: false,
      pauseReason: null,
      unsubscribed: true,
    });
    const res = await call({ userId: "u1", action: "resume" });
    expect((await res.json()).unsubscribed).toBe(true);
    expect(pause.setFollowUpPause).toHaveBeenCalledWith("u1", "resume", undefined);
  });

  it.each([
    ["no credential", null],
    ["the wrong one", "Bearer nope"],
    ["the internal API secret's header form", "pause-secret"],
  ])("refuses %s", async (_what, auth) => {
    expect((await call({ userId: "u1", action: "pause" }, auth)).status).toBe(401);
    expect(pause.setFollowUpPause).not.toHaveBeenCalled();
  });

  it("is off while no secret is set", async () => {
    env.LIFECYCLE_PAUSE_SECRET = "";
    expect((await call({ userId: "u1", action: "pause" }, "Bearer ")).status).toBe(401);
  });

  it.each([
    [{ userId: "u1", action: "stop" }],
    [{ userId: "u1", action: "pause", reason: "add_to_crm" }],
    [{ action: "pause" }],
    [{ userId: "u1", action: "pause", email: "x@y.z" }],
  ])("refuses a malformed request %j", async (body) => {
    expect((await call(body)).status).toBe(400);
  });

  it("answers 404 for an unknown user", async () => {
    pause.setFollowUpPause.mockResolvedValue(null);
    expect((await call({ userId: "nobody", action: "pause" })).status).toBe(404);
  });
});
