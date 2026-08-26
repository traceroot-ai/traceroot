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

const createDetectorMock = vi.fn();
vi.mock("@/lib/write-services/detectors", () => ({
  createDetector: (...args: unknown[]) => createDetectorMock(...args),
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

import { POST } from "./route";

const validBody = {
  actorUserId: "u1",
  projectId: "p1",
  name: "Latency spike",
  template: "custom",
  prompt: "Find traces with slow spans",
  transport: "agent",
};

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  createDetectorMock.mockReset();
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("POST /api/internal/write/detectors", () => {
  it("rejects an unauthorized caller before touching the service", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const res = await POST(makeRequest(validBody));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: "Unauthorized" });
    expect(createDetectorMock).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const badRequest = {
      json: async () => {
        throw new SyntaxError("bad json");
      },
    } as unknown as Parameters<typeof POST>[0];

    const res = await POST(badRequest);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Invalid JSON" });
    expect(createDetectorMock).not.toHaveBeenCalled();
  });

  it("returns 400 when actorUserId is missing", async () => {
    const { actorUserId: _dropped, ...rest } = validBody;

    const res = await POST(makeRequest(rest));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("actorUserId is required");
    expect(createDetectorMock).not.toHaveBeenCalled();
  });

  it("returns 400 when prompt is empty", async () => {
    const res = await POST(makeRequest({ ...validBody, prompt: "" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("prompt is required");
    expect(createDetectorMock).not.toHaveBeenCalled();
  });

  it("maps a service failure to its status and error", async () => {
    createDetectorMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Requires MEMBER role or higher",
    });

    const res = await POST(makeRequest(validBody));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({ error: "Requires MEMBER role or higher" });
  });

  it("passes a service-level validation message through as 400", async () => {
    createDetectorMock.mockResolvedValue({
      ok: false,
      status: 400,
      error: "condition 1 has an unknown field",
    });

    const res = await POST(
      makeRequest({
        ...validBody,
        triggerConditions: [{ field: "nope", op: "=", value: "x" }],
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "condition 1 has an unknown field" });
  });

  it("returns the created detector and forwards provenance", async () => {
    const detector = {
      id: "d1",
      name: "Latency spike",
      projectId: "p1",
      enabled: true,
      sampleRate: 25,
    };
    createDetectorMock.mockResolvedValue({ ok: true, created: true, data: detector });

    const res = await POST(
      makeRequest({
        ...validBody,
        sampleRate: 25,
        outputSchema: [],
        triggerConditions: [{ field: "cost", op: ">", value: 5 }],
        detectionSource: "byok",
        detectionModel: "gpt-x",
        detectionProvider: "openai",
        enableRca: false,
        enabled: true,
        agentSessionId: "as1",
      }),
    );

    expect(createDetectorMock).toHaveBeenCalledWith({
      actorUserId: "u1",
      projectId: "p1",
      name: "Latency spike",
      template: "custom",
      prompt: "Find traces with slow spans",
      sampleRate: 25,
      outputSchema: [],
      triggerConditions: [{ field: "cost", op: ">", value: 5 }],
      detectionSource: "byok",
      detectionModel: "gpt-x",
      detectionProvider: "openai",
      enableRca: false,
      enabled: true,
      provenance: { transport: "agent", agentSessionId: "as1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: true, detector });
  });

  it("normalizes an omitted agentSessionId to null for the service", async () => {
    const detector = {
      id: "d1",
      name: "Latency spike",
      projectId: "p1",
      enabled: true,
      sampleRate: 25,
    };
    createDetectorMock.mockResolvedValue({ ok: true, created: false, data: detector });

    const res = await POST(makeRequest({ ...validBody, transport: "public-api" }));

    expect(createDetectorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: { transport: "public-api", agentSessionId: null },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: false, detector });
  });
});
