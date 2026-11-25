import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
const m = vi.hoisted(() => ({
  user: { id: "u-new", email: "new@acme.dev" },
  save: vi.fn(),
  finish: vi.fn(),
  welcome: vi.fn(),
  after: [] as (() => Promise<unknown>)[],
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<unknown>) => void m.after.push(task),
}));
vi.mock("@/lib/email/welcome/welcome-schedule", () => ({ sendScheduledWelcome: m.welcome }));
vi.mock("@/lib/auth-helpers", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireAuth: async () => ({ user: m.user }),
    errorResponse: (error: string, status: number) => NextResponse.json({ error }, { status }),
    successResponse: (data: unknown) => NextResponse.json(data),
  };
});
vi.mock("@/lib/onboarding-answers", () => ({
  readOnboardingAnswers: vi.fn(),
  saveOnboardingAnswers: m.save,
  finishOnboardingQuestions: m.finish,
}));

import { PATCH, POST } from "./route";
import { ANSWERS_USER_HEADER, MAX_ANSWERS_BODY_BYTES } from "@/lib/onboarding-questions";

const request = (method: string, body?: string, forUser: string | null = "u-new") =>
  new NextRequest("http://localhost/api/onboarding/questions", {
    method,
    body,
    headers: forUser ? { [ANSWERS_USER_HEADER]: forUser } : {},
  });

beforeEach(() => {
  m.save.mockReset().mockResolvedValue(undefined);
  m.finish.mockReset().mockResolvedValue({ finished: true });
  m.welcome.mockReset().mockResolvedValue({ status: "sent", id: "e1" });
  m.after.length = 0;
});

describe("PATCH /api/onboarding/questions", () => {
  it("saves answers for the account the page was opened for", async () => {
    const res = await PATCH(request("PATCH", '{"role":"founder"}'));
    expect(res.status).toBe(200);
    expect(m.save).toHaveBeenCalledWith("u-new", { role: "founder" });
  });

  it("refuses a body over the limit, and saves nothing", async () => {
    const big = JSON.stringify({ company: "x".repeat(MAX_ANSWERS_BODY_BYTES) });
    const res = await PATCH(request("PATCH", big));
    expect(res.status).toBe(413);
    expect(m.save).not.toHaveBeenCalled();
  });

  it.each([
    ["another account", "u-old"],
    ["no account", null],
  ])("refuses a save made for %s, and saves nothing", async (_who, forUser) => {
    const res = await PATCH(request("PATCH", '{"role":"founder"}', forUser));
    expect(res.status).toBe(409);
    expect(m.save).not.toHaveBeenCalled();
  });
});

describe("POST /api/onboarding/questions", () => {
  it("finishes for the account the page was opened for", async () => {
    expect((await POST(request("POST"))).status).toBe(200);
    expect(m.finish).toHaveBeenCalledWith("u-new", "new@acme.dev");
  });

  it("refuses to finish for another account", async () => {
    expect((await POST(request("POST", undefined, "u-old"))).status).toBe(409);
    expect(m.finish).not.toHaveBeenCalled();
    expect(m.after).toHaveLength(0);
  });

  it("sends the welcome once the response is on its way, from the call that finishes", async () => {
    const response = await POST(request("POST"));
    expect(await response.json()).toEqual({ finished: true });
    expect(m.welcome).not.toHaveBeenCalled();
    expect(m.after).toHaveLength(1);
    await m.after[0]();
    expect(m.welcome).toHaveBeenCalledWith("u-new");
  });

  it("sends nothing from a second finish (a double-click, another tab)", async () => {
    m.finish.mockResolvedValue({ finished: false });
    await POST(request("POST"));
    expect(m.after).toHaveLength(0);
  });

  it("keeps a failed welcome from surfacing; the scheduled run sends it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    m.welcome.mockRejectedValue(new Error("db down"));
    expect((await POST(request("POST"))).status).toBe(200);
    await expect(m.after[0]()).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();
  });
});
