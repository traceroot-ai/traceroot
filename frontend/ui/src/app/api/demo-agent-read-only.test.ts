import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ role: "VIEWER", workspaceId: "demo" }));
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { id: "user" } }),
  requireProjectAccess: async () => ({
    project: { workspaceId: state.workspaceId },
    membership: { role: state.role },
  }),
  successResponse: (data: unknown, status = 200) => Response.json(data, { status }),
}));
vi.mock("@traceroot/core", () => ({
  Role: { ADMIN: "ADMIN" },
  ModelSource: { BYOK: "BYOK" },
  PlanType: { FREE: "free" },
  isBillingEnabled: () => false,
  prisma: { workspace: { findUnique: async () => null }, modelProvider: { findFirst: vi.fn() } },
}));

import { POST as create, GET as list } from "./projects/[projectId]/ai/sessions/route";
import { DELETE as remove } from "./projects/[projectId]/ai/sessions/[sessionId]/route";
import {
  POST as send,
  GET as read,
} from "./projects/[projectId]/ai/sessions/[sessionId]/messages/route";
import { POST as decide } from "./projects/[projectId]/ai/sessions/[sessionId]/decisions/route";

const params = { params: Promise.resolve({ projectId: "project", sessionId: "session" }) };
const fetchMock = vi.fn();
const request = () =>
  new Request("http://localhost", {
    method: "POST",
    body: JSON.stringify({ message: "hello", title: "test", decisionId: "d", action: "approve" }),
  });
const writes = [create, remove, send, decide];

beforeEach(() => {
  vi.stubEnv("DEMO_WORKSPACE_ID", "demo");
  state.workspaceId = "demo";
  state.role = "VIEWER";
  fetchMock
    .mockReset()
    .mockImplementation(async () => Response.json({ messages: [], sessions: [] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("demo agent writes", () => {
  it.each(["VIEWER", "MEMBER"])(
    "blocks every mutation for demo %s before contacting the agent",
    async (role) => {
      state.role = role;
      for (const handler of writes) {
        const response = await handler(request() as never, params);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "Demo conversations are read-only." });
      }
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["demo", "ADMIN"],
    ["own", "VIEWER"],
    ["own", "MEMBER"],
  ])("preserves writes for %s / %s", async (workspace, role) => {
    state.workspaceId = workspace;
    state.role = role;
    for (const handler of writes)
      expect((await handler(request() as never, params)).status).toBeLessThan(300);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it("preserves session and message reads for demo visitors", async () => {
    expect((await list(request() as never, params)).status).toBe(200);
    expect((await read(request() as never, params)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
