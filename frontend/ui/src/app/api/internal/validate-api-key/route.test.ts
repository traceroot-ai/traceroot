import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

const findUniqueMock = vi.fn();
const updateMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    accessKey: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
  },
  PlanType: { FREE: "free" },
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { POST } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

/** A prisma accessKey row as the route's `findUnique` select shapes it. */
function accessKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    projectId: "proj-123",
    name: "CI key",
    keyHint: "tr-d0a3-57e3",
    expireTime: null,
    project: {
      id: "proj-123",
      name: "My Project",
      deleteTime: null,
      workspace: {
        id: "ws-456",
        name: "My Workspace",
        billingPlan: "pro",
        ingestionBlocked: false,
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  findUniqueMock.mockReset();
  updateMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
  updateMock.mockResolvedValue({});
});

describe("POST /api/internal/validate-api-key", () => {
  it("returns identity fields (project/workspace/key names + hint) on a valid key", async () => {
    findUniqueMock.mockResolvedValue(accessKeyRow());

    const res = await POST(makeRequest({ keyHash: "abc123" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      valid: true,
      projectId: "proj-123",
      projectName: "My Project",
      workspaceId: "ws-456",
      workspaceName: "My Workspace",
      keyName: "CI key",
      keyHint: "tr-d0a3-57e3",
      billingPlan: "pro",
      ingestionBlocked: false,
      expiresAt: null,
    });
    // lastUseTime is bumped on every successful validation.
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("returns keyName null when the access key is unnamed", async () => {
    findUniqueMock.mockResolvedValue(accessKeyRow({ name: null }));

    const res = await POST(makeRequest({ keyHash: "abc123" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.keyName).toBeNull();
  });

  it("rejects an unauthorized caller before touching the database", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest({ keyHash: "abc123" }));

    expect(res.status).toBe(401);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});
