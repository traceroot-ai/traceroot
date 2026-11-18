import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));

const verifyInternalSecretMock = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({
  verifyInternalSecret: (...args: unknown[]) => verifyInternalSecretMock(...args),
}));

const recordTraceActivityMock = vi.fn();
vi.mock("@/lib/trace-activity", () => ({
  recordTraceActivity: (...args: unknown[]) => recordTraceActivityMock(...args),
}));

import { POST } from "./route";

/**
 * The request the ingest worker sends. It lives in a file so the worker's test can
 * compare the request it builds with this one, and a change on one side fails a test.
 */
const exampleRequest = JSON.parse(
  readFileSync(join(__dirname, "request.example.json"), "utf8"),
) as { projectId: string };

function makeRequest(body: unknown | (() => Promise<unknown>)) {
  const json = typeof body === "function" ? body : async () => body;
  return { json } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  verifyInternalSecretMock.mockReset().mockReturnValue(true);
  recordTraceActivityMock.mockReset().mockResolvedValue({
    kind: "recorded",
    firstTrace: true,
    activeDayCounted: true,
    activeFirstWeek: false,
  });
});

describe("POST /api/internal/trace-activity", () => {
  it("records the project named in the worker's example request", async () => {
    const response = await POST(makeRequest(exampleRequest));

    expect(response.status).toBe(200);
    expect(recordTraceActivityMock).toHaveBeenCalledWith(exampleRequest.projectId);
    expect(await response.json()).toEqual({
      recorded: true,
      firstTrace: true,
      activeDayCounted: true,
      activeFirstWeek: false,
    });
  });

  it("rejects a caller without the internal secret before recording anything", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const response = await POST(makeRequest(exampleRequest));

    expect(response.status).toBe(401);
    expect(recordTraceActivityMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a body that is not JSON", () => Promise.reject(new SyntaxError("bad json")), "Invalid JSON"],
    ["a missing project id", {}, "projectId is required"],
    ["an empty project id", { projectId: "" }, "projectId is required"],
  ])("answers 400 to %s", async (_, body, error) => {
    const response = await POST(makeRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(recordTraceActivityMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a project that does not exist or was deleted", async () => {
    recordTraceActivityMock.mockResolvedValue({ kind: "unknown_project" });

    const response = await POST(makeRequest(exampleRequest));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Project not found" });
  });

  it("answers 409 while the worker has not recorded when it started reporting", async () => {
    // The worker then records its start and sends the report again.
    recordTraceActivityMock.mockResolvedValue({ kind: "tracking_not_started" });

    const response = await POST(makeRequest(exampleRequest));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "First-trace tracking has not started" });
  });

  it("answers 200 without recording for a demo workspace project", async () => {
    recordTraceActivityMock.mockResolvedValue({ kind: "demo_project" });

    const response = await POST(makeRequest(exampleRequest));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: false });
  });
});
