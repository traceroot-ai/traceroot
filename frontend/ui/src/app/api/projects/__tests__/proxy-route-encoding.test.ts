import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

const { requireAuth, requireProjectAccess, fetchMock } = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireProjectAccess: vi.fn(),
  fetchMock: vi.fn(),
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth,
  requireProjectAccess,
  successResponse: (data: unknown) => Response.json(data),
  errorResponse: (error: string, status: number) => Response.json({ error }, { status }),
}));
vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "test-internal-secret" } }));
vi.mock("@traceroot/core", () => ({
  prisma: { workspace: { findUnique: vi.fn().mockResolvedValue(null) } },
  ModelSource: { BYOK: "BYOK" },
  PlanType: { FREE: "FREE" },
  isBillingEnabled: () => false,
}));

import { GET as findings } from "../[projectId]/traces/[traceId]/findings/route";
import { GET as detectorRuns } from "../[projectId]/traces/[traceId]/detector-runs/route";
import { GET as live } from "../[projectId]/traces/[traceId]/live/route";
import { DELETE as deleteSession } from "../[projectId]/ai/sessions/[sessionId]/route";
import {
  GET as messages,
  POST as sendMessage,
} from "../[projectId]/ai/sessions/[sessionId]/messages/route";
import { POST as decisions } from "../[projectId]/ai/sessions/[sessionId]/decisions/route";

const routes = [
  { name: "findings", handler: findings, method: "GET", internal: true, suffix: "/findings" },
  {
    name: "detector runs",
    handler: detectorRuns,
    method: "GET",
    internal: true,
    suffix: "/detector-runs",
  },
  { name: "live trace", handler: live, method: "GET", internal: false, suffix: "/live" },
  { name: "delete session", handler: deleteSession, method: "DELETE", internal: false, suffix: "" },
  {
    name: "session history",
    handler: messages,
    method: "GET",
    internal: false,
    suffix: "/messages",
  },
  {
    name: "send message",
    handler: sendMessage,
    method: "POST",
    internal: false,
    suffix: "/messages",
  },
  {
    name: "session decisions",
    handler: decisions,
    method: "POST",
    internal: false,
    suffix: "/decisions",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  requireAuth.mockResolvedValue({ user: { id: "caller" } });
  requireProjectAccess.mockResolvedValue({ project: { workspaceId: "workspace" } });
  fetchMock.mockImplementation(async () => Response.json({ findings: [], runs: [] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe.each(routes)("$name proxy URL", (route) => {
  const isTrace = ["findings", "detector runs", "live trace"].includes(route.name);
  function invoke(id: string, projectId = "caller-project") {
    return route.handler(
      new NextRequest("http://localhost/api/proxy", {
        method: route.method,
        headers: { cookie: "better-auth.session_token=test-session" },
        ...(route.method === "POST"
          ? { body: JSON.stringify({ message: "hello", action: "skip" }) }
          : {}),
      }),
      // Next.js has already decoded dynamic route parameters at this boundary.
      { params: Promise.resolve({ projectId, traceId: id, sessionId: id }) },
    );
  }

  it.each([
    "normal-id",
    "victim-trace/findings?project_id=victim-project#",
    "../../projects/victim-project/traces?limit=50#",
    "..\\..\\projects\\victim-project\\traces?limit=50#",
    "id/with?reserved#characters..",
    "%2e%2e%2fprojects%2fvictim-project%3fproject_id=victim-project%23",
  ])("keeps the decoded ID in one path segment: %s", async (id) => {
    const response = await invoke(id);
    expect(response.status).toBe(200);
    expect(requireProjectAccess).toHaveBeenCalledWith("caller", "caller-project");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(new Request(input, init).url);
    const prefix = route.internal
      ? "/api/v1/internal/traces/"
      : `/api/v1/projects/caller-project/${isTrace ? "traces" : "sessions"}/`;
    expect(url.pathname).toBe(`${prefix}${encodeURIComponent(id)}${route.suffix}`);
    expect(
      decodeURIComponent(
        url.pathname.slice(prefix.length, route.suffix ? -route.suffix.length : undefined),
      ),
    ).toBe(id);
    expect(url.hash).toBe("");
    expect([...url.searchParams]).toEqual(route.internal ? [["project_id", "caller-project"]] : []);
    expect(new Request(input, init).method).toBe(route.method);
    expect(new Headers(init.headers).get("X-Internal-Secret")).toBe(
      route.internal ? "test-internal-secret" : null,
    );
  });

  it.each([".", ".."])("rejects a dot segment before fetching: %s", async (id) => {
    expect((await invoke(id)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("encodes the authorised project ID without adding query parameters", async () => {
    const projectId = "project/with?reserved#chars&project_id=other";
    await invoke("normal-id", projectId);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(requireProjectAccess).toHaveBeenCalledWith("caller", projectId);
    expect(url.hash).toBe("");
    if (route.internal) {
      expect([...url.searchParams]).toEqual([["project_id", projectId]]);
    } else {
      expect(url.pathname).toBe(
        `/api/v1/projects/${encodeURIComponent(projectId)}/${isTrace ? "traces" : "sessions"}/normal-id${route.suffix}`,
      );
      expect(url.search).toBe("");
    }
  });

  it("does not fetch for an unauthenticated caller", async () => {
    requireAuth.mockResolvedValue({ error: new Response(null, { status: 401 }) });
    expect((await invoke("normal-id")).status).toBe(401);
    expect(requireProjectAccess).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch when project access is denied", async () => {
    requireProjectAccess.mockResolvedValue({ error: new Response(null, { status: 403 }) });
    expect((await invoke("normal-id")).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
