import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSource } from "@traceroot/core";

const state = vi.hoisted(() => ({ role: "VIEWER", workspaceId: "demo" }));
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  project: vi.fn(),
  membership: vi.fn(),
  workspace: vi.fn(),
  provider: vi.fn(),
}));
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("@/lib/request-session", () => ({
  getRequestSession: mocks.session,
}));
vi.mock("@/env", () => ({ env: {} }));
vi.mock("@traceroot/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traceroot/core")>()),
  isBillingEnabled: () => false,
  prisma: {
    project: { findUnique: mocks.project },
    workspaceMember: { findUnique: mocks.membership },
    workspace: { findUnique: mocks.workspace },
    modelProvider: { findFirst: mocks.provider },
  },
}));

import { POST as create, GET as list } from "./projects/[projectId]/ai/sessions/route";
import { DELETE as remove } from "./projects/[projectId]/ai/sessions/[sessionId]/route";
import {
  POST as send,
  GET as read,
} from "./projects/[projectId]/ai/sessions/[sessionId]/messages/route";
import { POST as decide } from "./projects/[projectId]/ai/sessions/[sessionId]/decisions/route";

const params = (projectId = "project") => ({
  params: Promise.resolve({ projectId, sessionId: "session" }),
});
const fetchMock = vi.fn();
const request = () =>
  new Request("http://localhost", {
    method: "POST",
    body: JSON.stringify({
      message: "hello",
      title: "test",
      decisionId: "d",
      action: "create",
      source: ModelSource.BYOK,
    }),
  });
const executions = [
  ["create a session", create],
  ["send a message", send],
  ["submit a decision", decide],
] as const;
const writes = [create, send, decide, remove];

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DEMO_WORKSPACE_ID", "demo");
  state.workspaceId = "own";
  state.role = "VIEWER";
  mocks.session.mockResolvedValue({ user: { id: "user" } });
  mocks.project.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    workspaceId: state.workspaceId,
    name: "Project",
  }));
  mocks.membership.mockImplementation(
    async ({
      where,
    }: {
      where: { workspaceId_userId: { workspaceId: string; userId: string } };
    }) => ({ ...where.workspaceId_userId, role: state.role }),
  );
  mocks.workspace.mockResolvedValue({ aiBlocked: false, billingPlan: "pro" });
  mocks.provider.mockResolvedValue({ id: "provider" });
  fetchMock.mockImplementation(async () => Response.json({ messages: [], sessions: [] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("agent execution permissions", () => {
  it.each(executions)(
    "rejects a viewer trying to %s before any upstream work",
    async (_name, handler) => {
      const response = await handler(request() as never, params());

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Requires MEMBER role or higher" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.workspace).not.toHaveBeenCalled();
      expect(mocks.provider).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["own", "project"],
    ["other-workspace", "other-project"],
  ])("checks the current membership for %s / %s", async (workspaceId, projectId) => {
    state.workspaceId = workspaceId;
    for (const [, handler] of executions)
      expect((await handler(request() as never, params(projectId))).status).toBe(403);

    expect(mocks.project).toHaveBeenCalledWith({
      where: { id: projectId, deleteTime: null },
      select: { id: true, workspaceId: true, name: true },
    });
    expect(mocks.membership).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId, userId: "user" } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["VIEWER", "MEMBER"])(
    "blocks every mutation for demo %s before contacting the agent",
    async (role) => {
      state.workspaceId = "demo";
      state.role = role;
      for (const handler of writes) {
        const response = await handler(request() as never, params());
        expect(response.status).toBe(403);
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.workspace).not.toHaveBeenCalled();
      expect(mocks.provider).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["demo", "ADMIN"],
    ["own", "MEMBER"],
    ["own", "ADMIN"],
  ])("preserves writes for %s / %s", async (workspace, role) => {
    state.workspaceId = workspace;
    state.role = role;
    for (const handler of writes)
      expect((await handler(request() as never, params())).status).toBeLessThan(300);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(mocks.provider).toHaveBeenCalledExactlyOnceWith({ where: { workspaceId: workspace } });
  });

  it.each(["own", "demo"])(
    "preserves session and message reads for a %s viewer",
    async (workspaceId) => {
      state.workspaceId = workspaceId;
      expect((await list(request() as never, params())).status).toBe(200);
      expect((await read(request() as never, params())).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves a viewer's ability to delete their own session", async () => {
    expect((await remove(request() as never, params())).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
    expect(fetchMock.mock.calls[0][1].headers["x-user-id"]).toBe("user");
  });

  it("rejects further execution after an existing session's owner becomes a viewer", async () => {
    state.role = "MEMBER";
    expect((await create(request() as never, params())).status).toBe(201);
    state.role = "VIEWER";

    for (const handler of [send, decide])
      expect((await handler(request() as never, params())).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it.each(executions)("rejects a non-member trying to %s", async (_name, handler) => {
    mocks.membership.mockResolvedValue(null);
    const response = await handler(request() as never, params());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Not a member of this workspace" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it.each(executions)("rejects an anonymous caller trying to %s", async (_name, handler) => {
    mocks.session.mockResolvedValue(null);
    expect((await handler(request() as never, params())).status).toBe(401);
    expect(mocks.project).not.toHaveBeenCalled();
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
