import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

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

import {
  parseInternalWrite,
  projectEnvelopeShape,
  provenanceOf,
  serviceErrorResponse,
} from "./internal-write-route";

const schema = z.object({ ...projectEnvelopeShape, name: z.string().optional() });

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof parseInternalWrite>[0];
}

beforeEach(() => {
  verifyInternalSecretMock.mockReset();
  verifyInternalSecretMock.mockReturnValue(true);
});

describe("parseInternalWrite", () => {
  it("rejects an unauthorized caller before reading the body", async () => {
    verifyInternalSecretMock.mockReturnValue(false);
    const json = vi.fn();
    const r = await parseInternalWrite(
      { json } as unknown as Parameters<typeof parseInternalWrite>[0],
      schema,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(401);
    expect(await r.response.json()).toEqual({ error: "Unauthorized" });
    expect(json).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const r = await parseInternalWrite(
      {
        json: async () => {
          throw new SyntaxError("bad json");
        },
      } as unknown as Parameters<typeof parseInternalWrite>[0],
      schema,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(400);
    expect(await r.response.json()).toEqual({ error: "Invalid JSON" });
  });

  it("returns the first zod issue when the envelope is incomplete", async () => {
    const r = await parseInternalWrite(makeRequest({ actorUserId: "u1", transport: "ui" }), schema);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(400);
    expect(await r.response.json()).toEqual({ error: "projectId is required" });
  });

  it("accepts every transport the services record and hands back the raw body", async () => {
    for (const transport of ["public-api", "agent", "ui"]) {
      const body = { actorUserId: "u1", projectId: "p1", transport, extra: 1 };
      const r = await parseInternalWrite(makeRequest(body), schema);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data).toEqual({ actorUserId: "u1", projectId: "p1", transport });
      expect(r.raw).toBe(body);
    }
  });
});

describe("provenanceOf", () => {
  it("normalizes an omitted agentSessionId to null", () => {
    expect(provenanceOf({ transport: "public-api" })).toEqual({
      transport: "public-api",
      agentSessionId: null,
    });
    expect(provenanceOf({ transport: "agent", agentSessionId: "as1" })).toEqual({
      transport: "agent",
      agentSessionId: "as1",
    });
  });
});

describe("serviceErrorResponse", () => {
  it("maps a service failure to its status and error", async () => {
    const res = serviceErrorResponse({ status: 409, error: "taken" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "taken" });
  });
});
