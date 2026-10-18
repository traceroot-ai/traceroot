import { beforeEach, describe, expect, it, vi } from "vitest";

// Identity wrapper that records what it was handed, as in ../route.test.ts: the
// export must still be the wrapped function, because this route reads the
// session cookie.
const guard = vi.hoisted(() => ({ wrapped: [] as unknown[] }));
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => {
    guard.wrapped.push(handler);
    return handler;
  },
}));

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/env", () => ({ env: {} }));
vi.mock("@/lib/request-session", () => ({ getRequestSession: mocks.session }));
vi.mock("@traceroot/core", () => ({
  prisma: { auditLog: { findMany: (...a: unknown[]) => mocks.findMany(...a) } },
}));

import { GET } from "./route";

const call = () => GET(new Request("http://localhost/api/cli/handoff/sessions") as never);

beforeEach(() => {
  mocks.session.mockReset();
  mocks.findMany.mockReset();
  mocks.session.mockResolvedValue({
    user: { id: "u1", email: "u@example.com", name: null },
    session: { id: "browser-session" },
  });
});

describe("GET /api/cli/handoff/sessions", () => {
  it("is exported through the impersonation policy", () => {
    expect(guard.wrapped).toHaveLength(1);
    expect(GET).toBe(guard.wrapped[0]);
  });

  it("names the caller's sessions that a redemption recorded", async () => {
    mocks.findMany.mockResolvedValue([{ resourceId: "sess-a" }, { resourceId: "sess-b" }]);

    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionIds: ["sess-a", "sess-b"] });
    // Scoped to the caller and to redemption rows: another user's sessions, or
    // an audit row about something else that happens to name a session, are
    // never reported.
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { actorUserId: "u1", operation: "cli_handoff.redeemed", resourceType: "session" },
      select: { resourceId: true },
    });
  });

  it("401s without a session, reading nothing", async () => {
    mocks.session.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});
