import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: class {
    status: number;
    constructor(_body: unknown, init?: { status?: number }) {
      this.status = init?.status ?? 200;
    }
    static json = (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    });
  },
}));

const findUniqueMock = vi.fn();
const deleteMock = vi.fn();
const updateMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: {
    accessKey: {
      findUnique: (...a: unknown[]) => findUniqueMock(...a),
      delete: (...a: unknown[]) => deleteMock(...a),
      update: (...a: unknown[]) => updateMock(...a),
    },
  },
}));

import { DELETE } from "./route";

/** The authenticating key's row, as `requireApiKeyProject` selects it. */
function authRow() {
  return {
    id: "ak_caller",
    expireTime: null,
    scope: "admin",
    project: { id: "proj-A", name: "demo", deleteTime: null, workspace: { id: "ws-1" } },
  };
}

function request() {
  return {
    headers: {
      get: (n: string) => (n.toLowerCase() === "authorization" ? "Bearer tr-caller" : null),
    },
  } as unknown as Parameters<typeof DELETE>[0];
}

const params = (keyId: string) => ({ params: Promise.resolve({ keyId }) });

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockResolvedValue({});
  // First findUnique authenticates the caller; the second looks up the target.
  findUniqueMock.mockResolvedValueOnce(authRow());
});

describe("DELETE /api/public/api-keys/{keyId}", () => {
  it("revokes a key in the caller's project", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: "ak_old", projectId: "proj-A" });
    const res = await DELETE(request(), params("ak_old"));
    expect(res.status).toBe(204);
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: "ak_old" } });
  });

  it("reports a key in ANOTHER project as absent, not forbidden", async () => {
    // 404 rather than 403: the caller has no business learning that an id it
    // cannot touch exists.
    findUniqueMock.mockResolvedValueOnce({ id: "ak_other", projectId: "proj-B" });
    const res = await DELETE(request(), params("ak_other"));
    expect(res.status).toBe(404);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("404s an unknown key", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    expect((await DELETE(request(), params("nope"))).status).toBe(404);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("refuses to revoke the key making the request", async () => {
    // Honouring it would revoke the caller's own credential mid-flight and make
    // the result of any retry ambiguous. Rotation is mint-verify-then-revoke.
    findUniqueMock.mockResolvedValueOnce({ id: "ak_caller", projectId: "proj-A" });
    const res = await DELETE(request(), params("ak_caller"));
    expect(res.status).toBe(409);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated request before touching the database", async () => {
    findUniqueMock.mockReset();
    findUniqueMock.mockResolvedValue(null);
    const res = await DELETE(request(), params("ak_old"));
    expect(res.status).toBe(401);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
