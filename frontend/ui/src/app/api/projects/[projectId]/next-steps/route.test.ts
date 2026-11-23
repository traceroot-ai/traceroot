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

const db = vi.hoisted(() => ({
  project: vi.fn(),
  detector: vi.fn(),
  signal: vi.fn(),
  evaluationRun: vi.fn(),
}));
vi.mock("@traceroot/core", () => ({
  prisma: {
    project: { findUnique: (...args: unknown[]) => db.project(...args) },
    detector: { findFirst: (...args: unknown[]) => db.detector(...args) },
    signal: { findFirst: (...args: unknown[]) => db.signal(...args) },
    evaluationRun: { findFirst: (...args: unknown[]) => db.evaluationRun(...args) },
  },
}));

const resolveMock = vi.fn();
vi.mock("@/lib/first-trace-backfill", () => ({
  resolveFirstTraceReceiveTime: (...args: unknown[]) => resolveMock(...args),
}));

import { GET } from "./route";

const call = () =>
  GET({} as Parameters<typeof GET>[0], { params: Promise.resolve({ projectId: "proj_1" }) });

const PROJECT = { id: "proj_1", workspaceId: "ws_1", firstTraceReceiveTime: null };

beforeEach(() => {
  requireAuthMock.mockReset().mockResolvedValue({ user: { id: "user_1" } });
  requireProjectAccessMock.mockReset().mockResolvedValue({
    project: { id: "proj_1", workspaceId: "ws_1", name: "p" },
    membership: { workspaceId: "ws_1", userId: "user_1", role: "ADMIN" },
  });
  db.project.mockReset().mockResolvedValue(PROJECT);
  for (const find of [db.detector, db.signal, db.evaluationRun])
    find.mockReset().mockResolvedValue(null);
  resolveMock.mockReset().mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/projects/[projectId]/next-steps", () => {
  it("says nothing is done for a new project", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      first_trace: false,
      detector: false,
      signal: false,
      eval_run: false,
    });
  });

  it("reads each step from the project's own data", async () => {
    resolveMock.mockResolvedValue(new Date("2026-11-20T08:00:00Z"));
    db.detector.mockResolvedValue({ id: "det_1" });
    db.signal.mockResolvedValue({ id: "sig_1" });
    db.evaluationRun.mockResolvedValue({ id: "run_1" });

    expect(await (await call()).json()).toEqual({
      first_trace: true,
      detector: true,
      signal: true,
      eval_run: true,
    });
    // The first trace through the reader that fills an older project's time.
    expect(resolveMock).toHaveBeenCalledWith(PROJECT);
    // Each of the others scoped to this project.
    for (const find of [db.detector, db.signal, db.evaluationRun]) {
      expect(find).toHaveBeenCalledWith({ where: { projectId: "proj_1" }, select: { id: true } });
    }
  });

  it("answers 502, not 'not done', when a step cannot be read", async () => {
    resolveMock.mockRejectedValue(new Error("trace store down"));

    const response = await call();
    expect(response.status).toBe(502);
  });

  it("answers only someone with access to the project", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    expect((await call()).status).toBe(403);
    expect(db.project).not.toHaveBeenCalled();
  });

  it("answers 404 for a project that is not there", async () => {
    db.project.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
});
