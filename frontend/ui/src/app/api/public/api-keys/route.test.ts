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

const findUniqueMock = vi.fn();
const findFirstMock = vi.fn();
const findManyMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    accessKey: {
      findUnique: (...a: unknown[]) => findUniqueMock(...a),
      findFirst: (...a: unknown[]) => findFirstMock(...a),
      findMany: (...a: unknown[]) => findManyMock(...a),
      create: (...a: unknown[]) => createMock(...a),
      update: (...a: unknown[]) => updateMock(...a),
    },
  },
}));

import { GET, POST } from "./route";
import { hashApiKey } from "@/lib/api-keys";

const CALLER_KEY = "tr-caller-key";

/** The row `requireApiKeyProject` selects for the authenticating key. */
function authRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ak_caller",
    expireTime: null,
    scope: "admin",
    project: {
      id: "proj-A",
      name: "demo",
      deleteTime: null,
      workspace: { id: "ws-1" },
    },
    ...overrides,
  };
}

/** The row shape both routes select when returning key metadata. */
function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ak_1",
    keyHint: "tr-a439-a3dc",
    name: "traceroot-setup-demo",
    projectId: "proj-A",
    scope: "ingest",
    expireTime: null,
    lastUseTime: null,
    createTime: new Date("2026-07-28T12:00:00.000Z"),
    ...overrides,
  };
}

function request(body?: unknown, authorization: string | null = `Bearer ${CALLER_KEY}`) {
  return {
    headers: { get: (n: string) => (n.toLowerCase() === "authorization" ? authorization : null) },
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueMock.mockResolvedValue(authRow());
  updateMock.mockResolvedValue({});
});

describe("public api-keys auth", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await GET(request(undefined, null));
    expect(res.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown key", async () => {
    findUniqueMock.mockResolvedValue(null);
    const res = await GET(request());
    expect(res.status).toBe(401);
  });

  it("rejects an expired key", async () => {
    findUniqueMock.mockResolvedValue(authRow({ expireTime: new Date("2020-01-01") }));
    expect((await GET(request())).status).toBe(401);
  });

  it("rejects a key whose project was deleted", async () => {
    findUniqueMock.mockResolvedValue(
      authRow({ project: { ...authRow().project, deleteTime: new Date() } }),
    );
    expect((await GET(request())).status).toBe(401);
  });

  it("looks the key up by hash, never by the raw secret", async () => {
    findManyMock.mockResolvedValue([]);
    await GET(request());
    const where = findUniqueMock.mock.calls[0][0].where;
    expect(where.secretHash).toBe(hashApiKey(CALLER_KEY));
    expect(JSON.stringify(where)).not.toContain(CALLER_KEY);
  });

  it("gives the same flat 401 for every rejection reason", async () => {
    // Distinguishing "expired" from "unknown" hands an attacker free signal.
    const details: unknown[] = [];
    for (const row of [null, authRow({ expireTime: new Date("2020-01-01") })]) {
      findUniqueMock.mockResolvedValue(row);
      details.push(await (await GET(request())).json());
    }
    expect(details[0]).toEqual(details[1]);
  });
});

describe("GET /api/public/api-keys", () => {
  it("lists only the authenticated key's project and never a secret", async () => {
    findManyMock.mockResolvedValue([keyRow()]);
    const res = await GET(request());
    const body = await res.json();

    expect(findManyMock.mock.calls[0][0].where).toEqual({ projectId: "proj-A" });
    expect(body.keys[0]).toMatchObject({ id: "ak_1", hint: "tr-a439-a3dc" });
    // Only a hint is ever returned; the secret is unrecoverable by design.
    expect(JSON.stringify(body)).not.toContain("secretHash");
    expect(body.keys[0].key).toBeUndefined();
  });
});

describe("POST /api/public/api-keys", () => {
  it("mints a key for the caller's project and returns the secret exactly once", async () => {
    findFirstMock.mockResolvedValue(null);
    createMock.mockResolvedValue(keyRow());

    const res = await POST(request({ name: "traceroot-setup-demo" }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(typeof body.key).toBe("string");
    expect(body.key).toMatch(/^tr-/);
    // The project comes from the credential, never from client input.
    expect(createMock.mock.calls[0][0].data.projectId).toBe("proj-A");
    // Only the hash is stored.
    expect(createMock.mock.calls[0][0].data.secretHash).toBe(hashApiKey(body.key));
    expect(createMock.mock.calls[0][0].data).not.toHaveProperty("secret");
  });

  it("ignores a client-supplied project_id", async () => {
    findFirstMock.mockResolvedValue(null);
    createMock.mockResolvedValue(keyRow());
    await POST(request({ name: "x", project_id: "proj-SOMEONE-ELSE" }));
    expect(createMock.mock.calls[0][0].data.projectId).toBe("proj-A");
  });

  it("refuses a duplicate name instead of piling up indistinguishable keys", async () => {
    findFirstMock.mockResolvedValue({ id: "ak_existing" });
    const res = await POST(request({ name: "traceroot-setup-demo" }));
    expect(res.status).toBe(409);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("requires a name", async () => {
    const res = await POST(request({}));
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("defaults to a non-expiring key", async () => {
    findFirstMock.mockResolvedValue(null);
    createMock.mockResolvedValue(keyRow());
    await POST(request({ name: "x" }));
    // An application credential that silently expires takes tracing down later.
    expect(createMock.mock.calls[0][0].data.expireTime).toBeNull();
  });

  it("honours expires_in_days when asked", async () => {
    findFirstMock.mockResolvedValue(null);
    createMock.mockResolvedValue(keyRow());
    await POST(request({ name: "x", expires_in_days: 30 }));
    const expireTime = createMock.mock.calls[0][0].data.expireTime as Date;
    const days = (expireTime.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("stores and reports the scope, now that it is enforced", async () => {
    findFirstMock.mockResolvedValue(null);
    createMock.mockResolvedValue(keyRow());
    const body = await (await POST(request({ name: "x", scope: "ingest" }))).json();
    expect(createMock.mock.calls[0][0].data.scope).toBe("ingest");
    expect(body.scope).toBe("ingest");
  });

  it("defaults a new key to ingest, the scope you get by not thinking", async () => {
    findFirstMock.mockResolvedValue(null);
    createMock.mockResolvedValue(keyRow());
    await POST(request({ name: "x" }));
    expect(createMock.mock.calls[0][0].data.scope).toBe("ingest");
  });

  it("rejects an unknown scope rather than storing it", async () => {
    const res = await POST(request({ name: "x", scope: "superuser" }));
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("refuses key management to an ingest-scoped key", async () => {
    // Without this a leaked application credential could mint an admin key.
    findUniqueMock.mockResolvedValue(authRow({ scope: "ingest" }));
    expect((await POST(request({ name: "x" }))).status).toBe(403);
    expect((await GET(request())).status).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("fails closed when the stored scope is unrecognised", async () => {
    // A row written by a future version, or corrupted, must not grant admin.
    findUniqueMock.mockResolvedValue(authRow({ scope: "something-new" }));
    expect((await GET(request())).status).toBe(403);
  });
});

describe("POST with an oversized body", () => {
  /** A request that declares more bytes than the handler will accept. */
  function oversized() {
    // `json` is a spy, so the test can assert the body was never parsed. Without
    // that, a handler that parsed first and only then returned 413 would pass a
    // test whose whole claim is that it refuses before parsing.
    const json = vi.fn(async () => ({ name: "x" }));
    const request = {
      headers: {
        get: (n: string) => {
          const name = n.toLowerCase();
          if (name === "authorization") return `Bearer ${CALLER_KEY}`;
          if (name === "content-length") return String(128 * 1024);
          return null;
        },
      },
      json,
    } as unknown as Parameters<typeof POST>[0];
    return { request, json };
  }

  it("is refused before the body is parsed or a key is minted", async () => {
    // The gateway's ceiling only covers callers who come through it; a project
    // key can POST here directly. The schema's 100-character `name` is checked
    // after the parse, so it bounds nothing on the wire.
    const { request, json } = oversized();

    const res = await POST(request);

    expect(res.status).toBe(413);
    expect(json).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });
});
