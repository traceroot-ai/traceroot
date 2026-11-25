import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  errorResponse: (error: string, status: number) => NextResponse.json({ error }, { status }),
}));

const projectFindUniqueMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: { project: { findUnique: (...args: unknown[]) => projectFindUniqueMock(...args) } },
}));

const resolveMock = vi.fn();
vi.mock("@/lib/first-trace-backfill", () => ({
  resolveFirstTraceReceiveTime: (...args: unknown[]) => resolveMock(...args),
}));

import { GET } from "./route";

const call = () =>
  GET({} as Parameters<typeof GET>[0], { params: Promise.resolve({ projectId: "proj_old" }) });

const PROJECT = { id: "proj_old", workspaceId: "ws_sam", firstTraceReceiveTime: null };

beforeEach(() => {
  requireAuthMock.mockReset().mockResolvedValue({ user: { id: "user_sam" } });
  requireProjectAccessMock.mockReset().mockResolvedValue({
    project: { id: "proj_old", workspaceId: "ws_sam", name: "old" },
    membership: { workspaceId: "ws_sam", userId: "user_sam", role: "VIEWER" },
  });
  projectFindUniqueMock.mockReset().mockResolvedValue(PROJECT);
  resolveMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/projects/[projectId]/first-trace", () => {
  it("answers the project's first-trace time, filled from the trace store when needed", async () => {
    resolveMock.mockResolvedValue(new Date("2026-10-01T08:30:00Z"));

    const response = await call();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ first_trace_receive_time: "2026-10-01T08:30:00.000Z" });
    expect(resolveMock).toHaveBeenCalledWith(PROJECT);
    expect(requireProjectAccessMock).toHaveBeenCalledWith("user_sam", "proj_old");
  });

  it("answers null while the project has no traces", async () => {
    resolveMock.mockResolvedValue(null);

    expect(await (await call()).json()).toEqual({ first_trace_receive_time: null });
  });

  it("answers 502 when the trace store cannot be read", async () => {
    resolveMock.mockRejectedValue(new Error("first-trace lookup failed with status 503"));

    const response = await call();

    expect(response.status).toBe(502);
  });

  it("stops at the access check for someone outside the workspace", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await call();

    expect(response.status).toBe(403);
    expect(resolveMock).not.toHaveBeenCalled();
  });
});
