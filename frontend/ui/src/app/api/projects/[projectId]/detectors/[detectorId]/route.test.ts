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
  errorResponse: (msg: string, status: number) => ({
    status,
    json: async () => ({ error: msg }),
  }),
  successResponse: (data: unknown, status = 200) => ({
    status,
    json: async () => data,
  }),
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
  detectorFindFirstMock.mockResolvedValue({ id: "det-1" });
  detectorUpdateMock.mockResolvedValue({ id: "det-1" });
});

describe("PATCH .../detectors/[detectorId] — triggerConditions validation", () => {
  it("upserts valid trigger conditions", async () => {
    const triggerConditions = [
      { field: "environment", op: "ne", value: "staging" },
      { field: "environment", op: "=", value: "production" },
      { field: "environment", op: "=", value: null },
    ];

    const res = await PATCH(makeRequest({ triggerConditions }), makeParams());

    expect(res.status).toBe(200);
    expect(detectorUpdateMock).toHaveBeenCalledTimes(1);
    expect(detectorUpdateMock.mock.calls[0][0].data.trigger.upsert).toEqual({
      create: {
        conditions: [
          { field: "environment", op: "!=", value: "staging" },
          { field: "environment", op: "=", value: "production" },
          { field: "environment", op: "=", value: null },
        ],
      },
      update: {
        conditions: [
          { field: "environment", op: "!=", value: "staging" },
          { field: "environment", op: "=", value: "production" },
          { field: "environment", op: "=", value: null },
        ],
      },
    });
  });

  it.each([null, [], "not-an-object"])("rejects non-object JSON body %s", async (body) => {
    const res = await PATCH(makeRequest(body), makeParams());

    expect(res.status).toBe(400);
    expect(detectorUpdateMock).not.toHaveBeenCalled();
  });

  it("ignores inherited top-level trigger conditions", async () => {
    const body = Object.create({
      triggerConditions: [{ field: "environment", op: ">", value: 10 }],
    });

    const res = await PATCH(makeRequest(body), makeParams());

    expect(res.status).toBe(200);
    expect(detectorUpdateMock).toHaveBeenCalledTimes(1);
    expect(detectorUpdateMock.mock.calls[0][0].data.trigger).toBeUndefined();
  });

  it.each([
    ["null", { triggerConditions: null }],
    ["non-array", { triggerConditions: { field: "environment", op: "=", value: "prod" } }],
    ["non-object entry", { triggerConditions: [null] }],
    ["blank field", { triggerConditions: [{ field: "", op: "=", value: "prod" }] }],
    ["unsupported field", { triggerConditions: [{ field: "duration", op: "<=", value: 1000 }] }],
    [
      "unsupported field operator",
      { triggerConditions: [{ field: "environment", op: "<=", value: 1000 }] },
    ],
    ["missing value", { triggerConditions: [{ field: "environment", op: "=" }] }],
    [
      "unsupported operator",
      { triggerConditions: [{ field: "environment", op: "contains", value: "prod" }] },
    ],
    [
      "non-scalar value",
      { triggerConditions: [{ field: "environment", op: "=", value: ["prod"] }] },
    ],
    [
      "unsupported numeric field",
      { triggerConditions: [{ field: "duration", op: ">=", value: "slow" }] },
    ],
    [
      "prototype field __proto__",
      { triggerConditions: [{ field: "__proto__", op: "=", value: "prod" }] },
    ],
    [
      "prototype field constructor",
      { triggerConditions: [{ field: "constructor", op: "=", value: "prod" }] },
    ],
    [
      "prototype field toString",
      { triggerConditions: [{ field: "toString", op: "=", value: "prod" }] },
    ],
  ])("rejects %s trigger conditions", async (_label, body) => {
    const res = await PATCH(makeRequest(body), makeParams());

    expect(res.status).toBe(400);
    expect(detectorUpdateMock).not.toHaveBeenCalled();
  });

  it("returns a field-specific operator error", async () => {
    const res = await PATCH(
      makeRequest({
        triggerConditions: [{ field: "environment", op: "contains", value: "production" }],
      }),
      makeParams(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "triggerConditions[0].op must be one of =, != for environment",
    });
    expect(detectorUpdateMock).not.toHaveBeenCalled();
  });
});
