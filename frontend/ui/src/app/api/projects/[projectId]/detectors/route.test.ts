import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({ NextRequest: class {} }));

const detectorCreateMock = vi.fn();
vi.mock("@traceroot/core", () => ({
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

describe("POST .../detectors — sampleRate default", () => {
  it.each([null, [], "not-an-object"])("rejects non-object JSON body %s", async (body) => {
    const res = await POST(makeRequest(body), makeParams());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Body must be a JSON object" });
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });

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

  it.each([
    ["detectionModel", { detectionModel: 123 }, "detectionModel must be a string"],
    [
      "detectionProvider",
      { detectionProvider: { provider: "openai" } },
      "detectionProvider must be a string",
    ],
  ])("rejects non-string %s values", async (_label, extra, error) => {
    const res = await POST(makeRequest(validBody(extra)), makeParams());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });
});

describe("POST .../detectors — triggerConditions validation", () => {
  it("stores valid trigger conditions", async () => {
    const triggerConditions = [
      { field: "environment", op: "eq", value: "production" },
      { field: "environment", op: "!=", value: "staging" },
      { field: "environment", op: "=", value: null },
    ];

    const res = await POST(makeRequest(validBody({ triggerConditions })), makeParams());

    expect(res.status).toBe(201);
    expect(detectorCreateMock.mock.calls[0][0].data.trigger.create.conditions).toEqual([
      { field: "environment", op: "=", value: "production" },
      { field: "environment", op: "!=", value: "staging" },
      { field: "environment", op: "=", value: null },
    ]);
  });

  it("ignores inherited top-level trigger conditions", async () => {
    const body = Object.assign(
      Object.create({
        triggerConditions: [{ field: "environment", op: ">", value: 10 }],
      }),
      validBody(),
    );

    const res = await POST(makeRequest(body), makeParams());

    expect(res.status).toBe(201);
    expect(detectorCreateMock.mock.calls[0][0].data.trigger.create.conditions).toEqual([]);
  });

  it.each([
    ["null", { triggerConditions: null }],
    ["non-array", { triggerConditions: { field: "environment", op: "=", value: "prod" } }],
    ["non-object entry", { triggerConditions: ["environment=prod"] }],
    ["blank field", { triggerConditions: [{ field: " ", op: "=", value: "prod" }] }],
    ["unsupported field", { triggerConditions: [{ field: "cost", op: ">", value: "10.5" }] }],
    [
      "unsupported field operator",
      { triggerConditions: [{ field: "environment", op: ">", value: 10 }] },
    ],
    ["missing value", { triggerConditions: [{ field: "environment", op: "=" }] }],
    [
      "unsupported operator",
      { triggerConditions: [{ field: "environment", op: "contains", value: "prod" }] },
    ],
    [
      "non-scalar value",
      { triggerConditions: [{ field: "environment", op: "=", value: { env: "prod" } }] },
    ],
    [
      "unsupported numeric field",
      { triggerConditions: [{ field: "cost", op: ">", value: "abc" }] },
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
  ])("rejects %s trigger conditions", async (_label, extra) => {
    const res = await POST(makeRequest(validBody(extra)), makeParams());

    expect(res.status).toBe(400);
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });

  it("returns a field-specific operator error", async () => {
    const res = await POST(
      makeRequest(
        validBody({
          triggerConditions: [{ field: "environment", op: "contains", value: "production" }],
        }),
      ),
      makeParams(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "triggerConditions[0].op must be one of =, != for environment",
    });
  });
});
