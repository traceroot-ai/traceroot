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
import { LAST_USE_TIME_REFRESH_INTERVAL_MS } from "./last-use";

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
    lastUseTime: null,
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
    // A never-used key (lastUseTime null) gets its "last seen" stamped once.
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes lastUseTime when it is older than the interval", async () => {
    const stale = new Date(Date.now() - LAST_USE_TIME_REFRESH_INTERVAL_MS - 1_000);
    findUniqueMock.mockResolvedValue(accessKeyRow({ lastUseTime: stale }));

    const res = await POST(makeRequest({ keyHash: "abc123" }));

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "key-1" },
      data: { lastUseTime: expect.any(Date) },
    });
  });

  it("skips the write when lastUseTime is within the interval", async () => {
    const fresh = new Date(Date.now() - 1_000);
    findUniqueMock.mockResolvedValue(accessKeyRow({ lastUseTime: fresh }));

    const res = await POST(makeRequest({ keyHash: "abc123" }));
    const body = await res.json();

    // Still a successful validation — only the redundant DB write is skipped.
    expect(res.status).toBe(200);
    expect(body.valid).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
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
