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

const startFirstTraceTrackingMock = vi.fn();
vi.mock("@/lib/first-trace-backfill", () => ({
  startFirstTraceTracking: (...args: unknown[]) => startFirstTraceTrackingMock(...args),
}));

import { POST } from "./route";

/**
 * The notice the ingest worker sends when it starts reporting. It lives in a file so
 * the worker's test can compare the request it builds with this one.
 */
const exampleRequest = JSON.parse(
  readFileSync(join(__dirname, "request.example.json"), "utf8"),
) as { startedAt: string };

const ALREADY_RECORDED = new Date("2026-11-17T08:00:00.000Z");

function makeRequest(body: unknown | (() => Promise<unknown>)) {
  const json = typeof body === "function" ? body : async () => body;
  return { json } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  verifyInternalSecretMock.mockReset().mockReturnValue(true);
  // As the database does: the first start given is the one kept.
  startFirstTraceTrackingMock.mockReset().mockImplementation(async (startedAt: Date) => startedAt);
});

describe("POST /api/internal/first-trace-tracking", () => {
  it("records the start in the worker's example notice and answers it", async () => {
    const response = await POST(makeRequest(exampleRequest));

    expect(response.status).toBe(200);
    expect(startFirstTraceTrackingMock).toHaveBeenCalledWith(new Date(exampleRequest.startedAt));
    expect(await response.json()).toEqual({ startedAt: "2026-11-18T09:00:00.123Z" });
  });

  it("answers the start already recorded, which a later notice does not move", async () => {
    startFirstTraceTrackingMock.mockResolvedValue(ALREADY_RECORDED);

    const response = await POST(makeRequest(exampleRequest));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ startedAt: ALREADY_RECORDED.toISOString() });
  });

  it("rejects a caller without the internal secret before recording anything", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const response = await POST(makeRequest(exampleRequest));

    expect(response.status).toBe(401);
    expect(startFirstTraceTrackingMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a body that is not JSON", () => Promise.reject(new SyntaxError("bad json")), "Invalid JSON"],
    ["a missing start", {}, "startedAt must be an ISO-8601 time with an offset"],
    [
      "a start that is not a time",
      { startedAt: "yesterday" },
      "startedAt must be an ISO-8601 time with an offset",
    ],
    [
      "a start without an offset",
      { startedAt: "2026-11-18T09:00:00" },
      "startedAt must be an ISO-8601 time with an offset",
    ],
  ])("answers 400 to %s", async (_, body, error) => {
    const response = await POST(makeRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(startFirstTraceTrackingMock).not.toHaveBeenCalled();
  });
});
