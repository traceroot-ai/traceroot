import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The business handler is what is under test; the shared impersonation policy
// has its own coverage in support/route-guard.test.ts. (It matters here: that
// policy is what stops an impersonating employee minting a handoff, because
// impersonationDenial refuses every /api/cli/* path.)
//
// The mock is the identity, so the policy stays out of the assertions below --
// but it records what it was handed, because the export still has to be held to
// it somewhere. route-guard.test.ts's sweep over every cookie-authenticated
// route export does now walk this file (it exempts only the three cli/ routes
// that take no cookie), but that sweep reads the source for the wrapper's name,
// which an import alone satisfies. The check below is the behavioural half: it
// fails if the export stops being the wrapped function.
const guard = vi.hoisted(() => ({ wrapped: [] as unknown[] }));
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => {
    guard.wrapped.push(handler);
    return handler;
  },
}));

const ORIGIN = "https://app.traceroot.ai";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  project: vi.fn(),
  membership: vi.fn(),
  deleteMany: vi.fn(),
  create: vi.fn(),
  rateLimitOk: vi.fn((_key: string, _max: number, _windowMs: number) => true),
  // Which client each cli_handoffs write came through. Both delegate to the
  // spies above, so this is the only thing that tells a write inside the
  // transaction from one on the bare client.
  through: [] as string[],
  // Every raw statement, with the client it went through.
  raw: [] as { via: string; sql: string; values: unknown[] }[],
}));

function rawStatement(via: string) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    mocks.through.push(`${via}.lock`);
    mocks.raw.push({ via, sql: strings.join("?"), values });
    return 1;
  };
}

vi.mock("@/env", () => ({ env: { BETTER_AUTH_URL: "https://app.traceroot.ai/" } }));
vi.mock("@/lib/request-session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/mint-rate-limit", () => ({
  checkMintRateLimit: (key: string, max: number, windowMs: number) =>
    mocks.rateLimitOk(key, max, windowMs),
  rateLimitClientKey: () => "test-client",
}));
vi.mock("@traceroot/core", () => ({
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
  hasMinRole: (role: string, min: string) =>
    ["VIEWER", "MEMBER", "ADMIN"].indexOf(role) >= ["VIEWER", "MEMBER", "ADMIN"].indexOf(min),
  prisma: {
    project: { findUnique: (...a: unknown[]) => mocks.project(...a) },
    workspaceMember: { findUnique: (...a: unknown[]) => mocks.membership(...a) },
    cliHandoff: {
      deleteMany: (...a: unknown[]) => {
        mocks.through.push("prisma.deleteMany");
        return mocks.deleteMany(...a);
      },
      create: (...a: unknown[]) => {
        mocks.through.push("prisma.create");
        return mocks.create(...a);
      },
    },
    $executeRaw: rawStatement("prisma"),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRaw: rawStatement("tx"),
        cliHandoff: {
          deleteMany: (...a: unknown[]) => {
            mocks.through.push("tx.deleteMany");
            return mocks.deleteMany(...a);
          },
          create: (...a: unknown[]) => {
            mocks.through.push("tx.create");
            return mocks.create(...a);
          },
        },
      }),
  },
}));

import { POST } from "./route";

function request(body: unknown, headers: Record<string, string> = { origin: ORIGIN }) {
  return {
    headers: new Headers(headers),
    json: async () => {
      if (body === "malformed") throw new SyntaxError("bad json");
      return body;
    },
  } as unknown as Parameters<typeof POST>[0];
}

afterEach(() => {
  // The pruning test spies on console.error. mockRestore() at the end of a test
  // body never runs if an assertion above it fails, and resetAllMocks does not
  // uninstall a spy -- console.error would stay silenced for the rest of the
  // file.
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.through.length = 0;
  mocks.raw.length = 0;
  mocks.rateLimitOk.mockReturnValue(true);
  mocks.session.mockResolvedValue({
    user: { id: "u1", email: "u@example.com", name: null },
    session: { id: "browser-session" },
  });
  mocks.project.mockResolvedValue({ id: "p1", workspaceId: "w1", name: "Proj" });
  mocks.membership.mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "MEMBER" });
  mocks.deleteMany.mockResolvedValue({ count: 0 });
  mocks.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "handoff-1",
    ...data,
  }));
});

describe("POST /api/cli/handoff", () => {
  it("is exported through the impersonation policy, not as a bare handler", async () => {
    // The mint is cookie-authenticated, so this wrapper is what stops a support
    // engineer minting a handoff on a customer's account -- the policy denies
    // every /api/cli/* path, and an unwrapped export would never ask it. The
    // mock is the identity, so the exported POST must be the very function the
    // wrapper was handed.
    expect(guard.wrapped).toHaveLength(1);
    expect(POST).toBe(guard.wrapped[0]);
  });

  it("mints a trh_ ticket bound to the user, the project and the issuing tab", async () => {
    const before = Date.now();
    const res = await POST(request({ projectId: "p1" }));
    const body = (await res.json()) as { code: string; expiresIn: number; expiresAt: string };

    expect(res.status).toBe(200);
    // base64url of 32 bytes is 43 characters of [A-Za-z0-9_-], which the
    // hand-back step can print unquoted on a shell line.
    expect(body.code).toMatch(/^trh_[A-Za-z0-9_-]{43}$/);
    // camelCase, matching /api/cli/token -- not the RFC 8628 snake_case of the
    // device endpoints, which this is not.
    expect(body.expiresIn).toBe(600);
    const expiresAt = Date.parse(body.expiresAt);
    expect(body.expiresAt).toBe(new Date(expiresAt).toISOString());
    expect(expiresAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(expiresAt).toBeLessThan(before + 600_000 + 5000);

    const data = mocks.create.mock.calls[0][0].data;
    expect(data.userId).toBe("u1");
    expect(data.issuedBySessionId).toBe("browser-session");
    expect(data.projectId).toBe("p1");
    expect(data.workspaceId).toBe("w1");
    expect(data.expiresAt.getTime()).toBe(expiresAt);
  });

  it("stores only the SHA-256 of the code, never the code", async () => {
    const res = await POST(request({ projectId: "p1" }));
    const { code } = (await res.json()) as { code: string };

    const data = mocks.create.mock.calls[0][0].data;
    expect(data.codeHash).toBe(createHash("sha256").update(code).digest("hex"));
    expect(data.codeHash).toMatch(/^[0-9a-f]{64}$/);
    // A read of the table must not yield a usable credential.
    expect(JSON.stringify(data)).not.toContain(code);
  });

  it("issues a different code every time", async () => {
    const first = (await (await POST(request({ projectId: "p1" }))).json()) as { code: string };
    const second = (await (await POST(request({ projectId: "p1" }))).json()) as { code: string };
    expect(first.code).not.toBe(second.code);
  });

  it("keeps one live handoff per user: the mint drops the rest in the same transaction", async () => {
    mocks.deleteMany.mockResolvedValue({ count: 2 });

    await POST(request({ projectId: "p1" }));

    // Scoped to this user and to UNREDEEMED rows: a code the user's own
    // terminal claimed a moment ago keeps its provenance.
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", redeemedAt: null },
    });
    // lock-then-delete-then-create, all through the transaction's client rather
    // than the bare one -- a create outside it would leave the delete committed
    // on its own, and a lock outside it would be released before the delete
    // ran. The trailing delete is the expiry sweep, which is deliberately not
    // in the transaction: it runs once the mint has committed.
    expect(mocks.through).toEqual(["tx.lock", "tx.deleteMany", "tx.create", "prisma.deleteMany"]);
  });

  it("serializes mints per user with a transaction-scoped advisory lock", async () => {
    await POST(request({ projectId: "p1" }));

    // The xact variant, so the lock lives exactly as long as the transaction
    // that deletes and inserts under it; keyed under its own namespace and the
    // user, so two of one user's mints queue and nobody else's do. See
    // route.race.test.ts for the overlap it prevents.
    expect(mocks.raw).toEqual([
      {
        via: "tx",
        sql: "SELECT pg_advisory_xact_lock(hashtext('cli_handoffs'), hashtext(?))",
        values: ["u1"],
      },
    ]);
  });

  it("sweeps long-expired rows after the mint, and still mints if the sweep fails", async () => {
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    const before = Date.now();
    await POST(request({ projectId: "p1" }));

    // Nothing prunes the adjacent device_codes table, so this one sweeps itself.
    // The cutoff is a session's whole inactivity window, so a redeemed row
    // outlives the session it minted unless that session is kept alive by use
    // (see the retention comment in lib/cli-handoff.ts).
    const sweep = mocks.deleteMany.mock.calls.find(
      (c) => (c[0] as { where: { expiresAt?: unknown } }).where.expiresAt,
    );
    expect(sweep).toBeDefined();
    const cutoff = (sweep![0] as { where: { expiresAt: { lt: Date } } }).where.expiresAt.lt;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - SEVEN_DAYS);
    expect(cutoff.getTime()).toBeLessThan(before - SEVEN_DAYS + 5000);

    mocks.deleteMany.mockReset();
    mocks.deleteMany.mockImplementation(async (args: { where: { expiresAt?: unknown } }) => {
      if (args.where.expiresAt) throw new Error("sweep exploded");
      return { count: 0 };
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(request({ projectId: "p1" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(res.status).toBe(200);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("pruning expired handoffs failed"),
      expect.any(Error),
    );
  });

  it("401s without a session, writing nothing", async () => {
    mocks.session.mockResolvedValue(null);
    const res = await POST(request({ projectId: "p1" }));
    expect(res.status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("403s for a project the user is not a member of", async () => {
    mocks.membership.mockResolvedValue(null);
    const res = await POST(request({ projectId: "p1" }));
    expect(res.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("403s when the user is below MEMBER on the project's workspace", async () => {
    mocks.membership.mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "VIEWER" });
    const res = await POST(request({ projectId: "p1" }));
    expect(res.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("404s for a project that does not exist", async () => {
    mocks.project.mockResolvedValue(null);
    const res = await POST(request({ projectId: "nope" }));
    expect(res.status).toBe(404);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("400s on a missing or malformed body", async () => {
    expect((await POST(request({}))).status).toBe(400);
    expect((await POST(request("malformed"))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin POST before touching the session", async () => {
    const res = await POST(request({ projectId: "p1" }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();

    const missing = await POST(request({ projectId: "p1" }, {}));
    expect(missing.status).toBe(403);
  });

  it("rate limits on its own budget, not the one /api/cli/token spends", async () => {
    mocks.rateLimitOk.mockReturnValue(false);
    const res = await POST(request({ projectId: "p1" }));
    expect(res.status).toBe(429);
    expect(mocks.rateLimitOk).toHaveBeenCalledWith("cli-handoff-mint:test-client", 10, 60_000);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
