import { describe, it, expect, vi, beforeEach } from "vitest";

// Business-handler unit tests isolate the shared policy (covered in support/route-guard.test.ts and E2E).
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

vi.mock("next/server", () => ({ NextRequest: class {} }));

const detectorCreateMock = vi.fn();
const listWorkspaceModelsMock = vi.fn();
vi.mock("@traceroot/core", async (importOriginal) => {
  // The model check itself is real; the workspace's list is stubbed.
  const { detectorModelProblem } = await importOriginal<typeof import("@traceroot/core")>();
  return {
    Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
    prisma: {
      detector: {
        create: (...args: unknown[]) => detectorCreateMock(...args),
      },
    },
    detectorModelProblem,
    listWorkspaceModels: (...args: unknown[]) => listWorkspaceModelsMock(...args),
  };
});

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
  requireProjectAccessMock.mockResolvedValue({
    project: { id: "proj-1", workspaceId: "ws-1", name: "Project" },
  });
  detectorCreateMock.mockResolvedValue({ id: "det-1" });
  listWorkspaceModelsMock.mockReset();
  listWorkspaceModelsMock.mockResolvedValue({
    systemModels: [
      {
        provider: "Anthropic",
        adapter: "anthropic",
        source: "system",
        models: [{ id: "claude-haiku-4-5", label: "claude-haiku-4-5" }],
      },
    ],
    byokProviders: [
      {
        provider: "My OpenAI",
        adapter: "openai",
        source: "byok",
        models: [{ id: "gpt-5.4", label: "gpt-5.4", supported: true }],
      },
    ],
  });
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

describe("POST .../detectors — name conflicts", () => {
  it("returns 409 when the name collides on the per-project unique index", async () => {
    detectorCreateMock.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    const res = await POST(makeRequest(validBody()), makeParams());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "A detector with this name already exists",
    );
  });

  it("propagates non-P2002 create failures", async () => {
    detectorCreateMock.mockRejectedValue(new Error("Database connection lost"));
    await expect(POST(makeRequest(validBody()), makeParams())).rejects.toThrow(
      "Database connection lost",
    );
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

describe("POST .../detectors — detection model", () => {
  it("does not read the workspace's models for the default choice", async () => {
    const res = await POST(makeRequest(validBody()), makeParams());

    expect(res.status).toBe(201);
    expect(listWorkspaceModelsMock).not.toHaveBeenCalled();
  });

  it("rejects a system model the workspace cannot use with 400 and the models it can", async () => {
    const res = await POST(makeRequest(validBody({ detectionModel: "claude-9" })), makeParams());

    expect(res.status).toBe(400);
    expect(listWorkspaceModelsMock).toHaveBeenCalledWith("ws-1");
    expect(((await res.json()) as { error: string }).error).toMatch(
      /^detection_model "claude-9" is not a system model this workspace can use\. System models: "claude-haiku-4-5"\. /,
    );
    expect(detectorCreateMock).not.toHaveBeenCalled();
  });

  it("stores a byok model configured on the named provider", async () => {
    const res = await POST(
      makeRequest(
        validBody({
          detectionSource: "byok",
          detectionProvider: "My OpenAI",
          detectionModel: "gpt-5.4",
        }),
      ),
      makeParams(),
    );

    expect(res.status).toBe(201);
    expect(detectorCreateMock.mock.calls[0][0].data).toMatchObject({
      detectionSource: "byok",
      detectionProvider: "My OpenAI",
      detectionModel: "gpt-5.4",
    });
  });
});
