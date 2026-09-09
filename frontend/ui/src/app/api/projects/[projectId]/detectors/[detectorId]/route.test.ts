import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const detectorFindFirstMock = vi.fn();
const detectorUpdateMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    detector: {
      findFirst: (...args: unknown[]) => detectorFindFirstMock(...args),
      update: (...args: unknown[]) => detectorUpdateMock(...args),
    },
  },
}));

const requireAuthMock = vi.fn();
const requireProjectAccessMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireProjectAccess: (...args: unknown[]) => requireProjectAccessMock(...args),
  errorResponse: (msg: string, status: number) => ({ status, json: async () => ({ error: msg }) }),
  successResponse: (data: unknown, status = 200) => ({ status, json: async () => data }),
}));

import { PATCH } from "./route";

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

function makeParams() {
  return { params: Promise.resolve({ projectId: "proj-1", detectorId: "det-1" }) };
}

beforeEach(() => {
  detectorFindFirstMock.mockReset();
  detectorUpdateMock.mockReset();
  requireAuthMock.mockReset();
  requireProjectAccessMock.mockReset();
  requireAuthMock.mockResolvedValue({ user: { id: "user-1" } });
  requireProjectAccessMock.mockResolvedValue({});
  detectorFindFirstMock.mockResolvedValue({ id: "det-1", projectId: "proj-1" });
  detectorUpdateMock.mockResolvedValue({ id: "det-1" });
});

describe("PATCH .../detectors/[detectorId] — trigger conditions", () => {
  it("upserts a condition on an offered field", async () => {
    const conditions = [{ field: "metadata", op: "contains", value: "acme", key: "tenant" }];
    const res = await PATCH(makeRequest({ triggerConditions: conditions }), makeParams());

    expect(res.status).toBe(200);
    expect(detectorUpdateMock.mock.calls[0][0].data.trigger.upsert.update.conditions).toEqual(
      conditions,
    );
  });

  it("refuses to save a half-filled condition carried over from an older detector", async () => {
    // A row saved before the registry validation existed can hold an empty
    // value; saving it back would store a condition that matches nothing.
    const res = await PATCH(
      makeRequest({ triggerConditions: [{ field: "environment", op: "=", value: "" }] }),
      makeParams(),
    );

    expect(res.status).toBe(400);
    expect(detectorUpdateMock).not.toHaveBeenCalled();
  });

  it("refuses an operator the field does not offer", async () => {
    const res = await PATCH(
      makeRequest({ triggerConditions: [{ field: "cost", op: "contains", value: "1" }] }),
      makeParams(),
    );

    expect(res.status).toBe(400);
    expect(detectorUpdateMock).not.toHaveBeenCalled();
  });
});
