import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const detectorCreateMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
  prisma: {
    detector: {
      create: (...args: unknown[]) => detectorCreateMock(...args),
    },
  },
}));

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  errorResponse: (msg: string, status: number) => ({
    status,
    json: async () => ({ error: msg }),
  }),
  successResponse: (data: unknown, status = 200) => ({
    status,
    json: async () => data,
  }),
}));

import { Role } from "@traceroot/core";
import { POST } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

function makeParams() {
  return { params: Promise.resolve({ projectId: "proj-1" }) };
}

/** Minimal valid create payload — sampleRate intentionally omitted. */
function validBody(extra: Record<string, unknown> = {}) {
  return { name: "My detector", template: "failure", prompt: "Find failures", ...extra };
}

beforeEach(() => {
  detectorCreateMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({});
  detectorCreateMock.mockResolvedValue({ id: "det-1" });
});

describe("POST .../detectors — role gating", () => {
  it("returns 403 for a VIEWER-role member and never creates", async () => {
    requireProjectAccessMock.mockResolvedValue({
      error: { status: 403, json: async () => ({ error: "Requires MEMBER role or higher" }) },
    });

    const res = await POST(makeRequest(validBody()), makeParams());

    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1", Role.MEMBER);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("Requires MEMBER role or higher");
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });

  it("lets a MEMBER-role member create a detector", async () => {
    const res = await POST(makeRequest(validBody()), makeParams());

    expect(requireProjectAccessMock).toHaveBeenCalledWith("user-1", "proj-1", Role.MEMBER);
    expect(res.status).toBe(201);
    expect(detectorCreateMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST .../detectors — sampleRate default", () => {
  it("defaults sampleRate to 25 when omitted", async () => {
    const res = await POST(makeRequest(validBody()), makeParams());

    expect(res.status).toBe(201);
    expect(detectorCreateMock).toHaveBeenCalledTimes(1);
    expect(detectorCreateMock.mock.calls[0][0].data.sampleRate).toBe(25);
  });

  it("keeps an explicit sampleRate (100) instead of the default", async () => {
    const res = await POST(makeRequest(validBody({ sampleRate: 100 })), makeParams());

    expect(res.status).toBe(201);
    expect(detectorCreateMock.mock.calls[0][0].data.sampleRate).toBe(100);
  });

  it("rejects an out-of-range sampleRate", async () => {
    const res = await POST(makeRequest(validBody({ sampleRate: 101 })), makeParams());

    expect(res.status).toBe(400);
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });
});

describe("POST .../detectors — trigger conditions", () => {
  it("stores a condition on an offered field", async () => {
    const conditions = [{ field: "duration_ms", op: ">", value: 4500 }];
    const res = await POST(makeRequest(validBody({ triggerConditions: conditions })), makeParams());

    expect(res.status).toBe(201);
    expect(detectorCreateMock.mock.calls[0][0].data.trigger.create.conditions).toEqual(conditions);
  });

  it("rejects a condition the worker could not evaluate instead of storing it", async () => {
    // Stored, this detector would look configured and enabled while never
    // matching a trace, so the refusal has to happen at the write path.
    const res = await POST(
      makeRequest(validBody({ triggerConditions: [{ field: "trace_id", op: "=", value: "abc" }] })),
      makeParams(),
    );

    expect(res.status).toBe(400);
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });
});
