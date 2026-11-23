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

const reportDailyTraceCountsMock = vi.fn();
vi.mock("@/lib/trace-count", () => ({
  reportDailyTraceCounts: (...args: unknown[]) => reportDailyTraceCountsMock(...args),
}));

import { POST } from "./route";

const tick = () => POST({} as Parameters<typeof POST>[0]);

beforeEach(() => {
  verifyInternalSecretMock.mockReset().mockReturnValue(true);
  reportDailyTraceCountsMock.mockReset().mockResolvedValue({ kind: "sent", sent: 2, remaining: 0 });
});

describe("POST /api/internal/scheduled-tick", () => {
  it("runs the daily trace counts and reports what it did", async () => {
    const response = await tick();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ traceCounts: { kind: "sent", sent: 2, remaining: 0 } });
    expect(reportDailyTraceCountsMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a caller without the internal secret before doing any work", async () => {
    verifyInternalSecretMock.mockReturnValue(false);

    const response = await tick();

    expect(response.status).toBe(401);
    expect(reportDailyTraceCountsMock).not.toHaveBeenCalled();
  });
});
