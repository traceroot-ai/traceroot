import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findWorkspace: vi.fn(),
  read: vi.fn(),
  remove: vi.fn(),
  transaction: vi.fn(),
  fetch: vi.fn(),
  requireProjectAccess: vi.fn(),
}));

vi.mock("@traceroot/core", () => ({
  PlanType: { FREE: "free" },
  Role: { MEMBER: "MEMBER" },
  prisma: {
    workspace: { findUnique: mocks.findWorkspace },
    label: { findMany: mocks.read, deleteMany: mocks.remove },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/env", () => ({ env: { INTERNAL_API_SECRET: "test-secret" } }));
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ user: { id: "member-a" } }),
  requireProjectAccess: mocks.requireProjectAccess,
  errorResponse: (error: string, status: number) => Response.json({ error }, { status }),
  successResponse: (data: unknown) => Response.json(data),
}));

import { DELETE, GET } from "./route";

const url = "http://ui.test/api/projects/project-a/traces/trace-a/labels?spanId=span-a";
const context = { params: Promise.resolve({ projectId: "project-a", traceId: "trace-a" }) };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.requireProjectAccess.mockResolvedValue({ project: { workspaceId: "workspace-a" } });
  mocks.findWorkspace.mockResolvedValue({ billingPlan: "pro" });
});

afterEach(() => vi.unstubAllGlobals());

describe("trace label assignment eligibility", () => {
  it.each([
    [{ retention_days: 90 }, 403],
    ["Invalid internal secret", 502],
  ])("maps validation's 403 detail %o to status %d", async (detail, status) => {
    mocks.fetch.mockResolvedValue(Response.json({ detail }, { status: 403 }));

    const result = await GET(new Request(url) as Parameters<typeof GET>[0], context);

    expect(result.status).toBe(status);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("fails closed when validation returns an unexpected success response", async () => {
    mocks.fetch.mockResolvedValue(new Response("Unexpected content"));

    const result = await GET(new Request(url) as Parameters<typeof GET>[0], context);

    expect(result.status).toBe(502);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("removes only the member's own assignment and returns the same-label chip from another source", async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 204 }));
    const writeQuery = {};
    const readQuery = {};
    mocks.remove.mockReturnValue(writeQuery);
    mocks.read.mockReturnValue(readQuery);
    mocks.transaction.mockResolvedValue([
      { count: 1 },
      [{ value: "Needs review", authorId: "member-a", source: "SDK" }],
    ]);

    const request = new Request(url, {
      method: "DELETE",
      body: JSON.stringify({ value: "Needs review" }),
    });
    const result = await DELETE(request as Parameters<typeof DELETE>[0], context);

    expect(mocks.requireProjectAccess).toHaveBeenCalledWith("member-a", "project-a", "MEMBER");
    expect(mocks.remove).toHaveBeenCalledWith({
      where: {
        projectId: "project-a",
        traceId: "trace-a",
        spanId: "span-a",
        value: "Needs review",
        authorId: "member-a",
        source: "HUMAN",
      },
    });
    expect(mocks.transaction).toHaveBeenCalledWith([writeQuery, readQuery]);
    expect(await result.json()).toEqual({ values: ["Needs review"], appliedByMe: [] });
  });
});
