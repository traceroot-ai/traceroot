import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The prisma mock here is a store, not a stub, because the property under test
 * is a concurrency property: redemption must claim the row with a single
 * conditional UPDATE, never a read followed by a write.
 *
 * `cliHandoff.updateMany` below evaluates its `where` and applies its `data`
 * with no await in between, which is what Postgres guarantees under the row
 * lock -- a second UPDATE blocks on the lock, then re-evaluates the predicate
 * against the committed row. A handler that read the row, decided, and then
 * wrote would have two winners here exactly as it would in production.
 */

const mocks = vi.hoisted(() => ({
  rateLimitOk: vi.fn((_key: string, _max: number, _windowMs: number) => true),
  sessionCreateGate: null as null | Promise<void>,
  auditFails: false,
}));

vi.mock("@/env", () => ({ env: {} }));
vi.mock("@/lib/mint-rate-limit", () => ({
  checkMintRateLimit: (key: string, max: number, windowMs: number) =>
    mocks.rateLimitOk(key, max, windowMs),
  rateLimitClientKey: () => "test-client",
}));

type HandoffRow = {
  id: string;
  codeHash: string;
  userId: string;
  issuedBySessionId: string | null;
  projectId: string | null;
  workspaceId: string | null;
  expiresAt: Date;
  redeemedAt: Date | null;
  redeemedSessionId: string | null;
  user: { email: string; banned: boolean | null; banExpires: Date | null };
};
type SessionRow = Record<string, unknown> & { id: string; token: string };
type AuditRow = Record<string, unknown> & { summary: Record<string, unknown> };

// `claims` counts the conditional UPDATE the handler issues, so a test can say
// "this input reached the table" or "this one did not". `claimedBy` records the
// value each of those statements matched on, which is how a test can say the
// raw code never reached a query. `issuers` holds the browser sessions that
// minted the codes, apart from `sessions`, which holds only what redemption
// created.
const store = {
  handoffs: [] as HandoffRow[],
  sessions: [] as SessionRow[],
  issuers: [] as { id: string; ipAddress: string | null }[],
  audit: [] as AuditRow[],
  claims: 0,
  claimedBy: [] as string[],
};

function client() {
  return {
    cliHandoff: {
      // Single statement: predicate and write with no suspension between them.
      updateMany: async ({
        where,
        data,
      }: {
        where: { codeHash: string; redeemedAt?: null; expiresAt?: { gt: Date } };
        data: { redeemedAt: Date };
      }) => {
        store.claims += 1;
        store.claimedBy.push(where.codeHash);
        let count = 0;
        for (const row of store.handoffs) {
          // Every predicate comes from the handler's own `where`, so dropping
          // one there drops it here too -- which is the point of this test.
          if (row.codeHash !== where.codeHash) continue;
          if (where.redeemedAt === null && row.redeemedAt !== null) continue;
          if (where.expiresAt && row.expiresAt.getTime() <= where.expiresAt.gt.getTime()) continue;
          row.redeemedAt = data.redeemedAt;
          count += 1;
        }
        return { count };
      },
      findUnique: async ({ where }: { where: { codeHash: string } }) =>
        store.handoffs.find((r) => r.codeHash === where.codeHash) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { redeemedSessionId: string };
      }) => {
        const row = store.handoffs.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    session: {
      create: async ({ data }: { data: SessionRow }) => {
        if (mocks.sessionCreateGate) await mocks.sessionCreateGate;
        store.sessions.push(data);
        return data;
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        store.issuers.find((s) => s.id === where.id) ?? null,
    },
    // Only the transaction's client has this: the bare `prisma` below does not,
    // so an audit write outside the transaction fails every redemption test.
    auditLog: {
      create: async ({ data }: { data: AuditRow }) => {
        if (mocks.auditFails) throw new Error("audit insert failed");
        store.audit.push(data);
        return data;
      },
    },
  };
}

vi.mock("@traceroot/core", () => ({
  prisma: {
    $transaction: async (fn: (tx: ReturnType<typeof client>) => Promise<unknown>) => fn(client()),
  },
}));

import { hashHandoffCode } from "@/lib/cli-handoff";
import { POST } from "./route";

// `trh_` and 43 base64url characters, the shape the mint answers with -- an
// obvious placeholder rather than a value that could have come from a real
// mint. The lower-case run matters: the recasing test below depends on it.
const CODE = "trh_abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE";

function request(body: unknown, headers: Record<string, string> = {}) {
  return {
    headers: new Headers({ "user-agent": "traceroot-cli/0.7.0", ...headers }),
    json: async () => {
      if (body === "malformed") throw new SyntaxError("bad json");
      return body;
    },
  } as unknown as Parameters<typeof POST>[0];
}

function seed(overrides: Partial<HandoffRow> = {}) {
  const row: HandoffRow = {
    id: "handoff-1",
    codeHash: hashHandoffCode(CODE),
    userId: "u1",
    issuedBySessionId: "browser-session",
    projectId: "p1",
    workspaceId: "w1",
    expiresAt: new Date(Date.now() + 600_000),
    redeemedAt: null,
    redeemedSessionId: null,
    user: { email: "u@example.com", banned: null, banExpires: null },
    ...overrides,
  };
  store.handoffs.push(row);
  return row;
}

beforeEach(() => {
  store.handoffs = [];
  store.sessions = [];
  store.issuers = [];
  store.audit = [];
  store.claims = 0;
  store.claimedBy = [];
  mocks.sessionCreateGate = null;
  mocks.auditFails = false;
  mocks.rateLimitOk.mockReset();
  mocks.rateLimitOk.mockReturnValue(true);
});

describe("POST /api/cli/handoff/redeem", () => {
  it("exchanges a live code for a session token", async () => {
    seed();
    const res = await POST(request({ code: CODE }));
    const body = (await res.json()) as { sessionToken: string; email: string; expiresIn: number };

    expect(res.status).toBe(200);
    expect(body.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    // Saves the CLI a round trip: whoami is API-key-only server-side, so
    // browserSignIn otherwise mints a JWT purely to read the email claim.
    expect(body.email).toBe("u@example.com");
    expect(body.expiresIn).toBe(7 * 24 * 60 * 60);
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0].token).toBe(body.sessionToken);
  });

  it("produces the same session a device-flow approval would", async () => {
    seed();
    await POST(request({ code: CODE }));
    const session = store.sessions[0];

    // resolveSessionFromToken rejects impersonated sessions outright, so a
    // non-null value here would yield a session that mints nothing.
    expect(session.impersonatedBy).toBeNull();
    // Active Sessions labels any agent starting with this as "TraceRoot CLI";
    // drop it and a handoff session reads "Unknown device" instead.
    expect(session.userAgent).toBe("traceroot-cli/0.7.0");
    expect(session.userId).toBe("u1");
    const expiresAt = session.expiresAt as Date;
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
  });

  it("records when the code was spent and which session it produced", async () => {
    const row = seed();
    const res = await POST(request({ code: CODE }));
    const { sessionToken } = (await res.json()) as { sessionToken: string };

    expect(row.redeemedAt).toBeInstanceOf(Date);
    expect(row.redeemedSessionId).toBe(store.sessions[0].id);
    expect(store.sessions[0].token).toBe(sessionToken);
  });

  it("records the session it created as a handoff's, which is what Active Sessions marks", async () => {
    seed();
    const res = await POST(request({ code: CODE }));
    expect(res.status).toBe(200);

    // The session row is a device-flow row in every column, so this audit row
    // is the only thing that says where it came from. Keyed by the session id,
    // which is what /api/cli/handoff/sessions hands the page.
    expect(store.audit).toHaveLength(1);
    expect(store.audit[0]).toMatchObject({
      actorUserId: "u1",
      actorEmail: "u@example.com",
      operation: "cli_handoff.redeemed",
      resourceType: "session",
      resourceId: store.sessions[0].id,
      projectId: "p1",
      workspaceId: "w1",
      outcome: "success",
    });
    expect(store.audit[0].summary).toMatchObject({
      handoffId: "handoff-1",
      issuedBySessionId: "browser-session",
    });
    // Nothing a caller could replay: the summary names no code and no token.
    const serialized = JSON.stringify(store.audit[0]);
    expect(serialized).not.toContain(CODE);
    expect(serialized).not.toContain(store.sessions[0].token);
  });

  it("fails the redemption rather than create a session nothing marks", async () => {
    seed();
    mocks.auditFails = true;
    // In the transaction, not swallowed: a handoff session without its record
    // is the unmarked credential the record exists to prevent. The rollback
    // that keeps the code redeemable is Postgres's; here it is enough that
    // the failure reaches the transaction instead of being caught short of it.
    await expect(POST(request({ code: CODE }))).rejects.toThrow("audit insert failed");
  });

  it("records, and does not refuse, a code spent from another address than the tab that minted it", async () => {
    seed();
    store.issuers.push({ id: "browser-session", ipAddress: "198.51.100.4" });
    const res = await POST(request({ code: CODE }, { "x-forwarded-for": "203.0.113.7" }));

    // "Run this where your application lives" makes a second host the normal
    // case, so a mismatch is a record for the user and for support, never a
    // refusal.
    expect(res.status).toBe(200);
    expect(store.sessions).toHaveLength(1);
    expect(store.audit[0].summary).toMatchObject({
      mintedFrom: "198.51.100.4",
      redeemedFrom: "203.0.113.7",
      addressChanged: true,
    });
  });

  it("records the same address as unchanged, and an unknown one as unknown", async () => {
    seed();
    store.issuers.push({ id: "browser-session", ipAddress: "203.0.113.7" });
    await POST(request({ code: CODE }, { "x-forwarded-for": "203.0.113.7" }));
    expect(store.audit[0].summary).toMatchObject({
      mintedFrom: "203.0.113.7",
      redeemedFrom: "203.0.113.7",
      addressChanged: false,
    });

    // The minting tab signed out before the terminal ran: legitimate, and
    // nothing left to compare against, so neither true nor false.
    store.handoffs = [];
    store.issuers = [];
    seed();
    await POST(request({ code: CODE }, { "x-forwarded-for": "203.0.113.7" }));
    expect(store.audit[1].summary).toMatchObject({
      mintedFrom: null,
      redeemedFrom: "203.0.113.7",
      addressChanged: null,
    });
  });

  it.each([
    ["unknown", () => {}],
    ["expired", () => seed({ expiresAt: new Date(Date.now() - 1000) })],
    ["already redeemed", () => seed({ redeemedAt: new Date(Date.now() - 1000) })],
    ["banned user", () => seed({ user: { email: "u@x", banned: true, banExpires: null } })],
  ])("answers one indistinguishable 401 for a %s code", async (_label, setup) => {
    setup();
    const res = await POST(request({ code: CODE }));
    expect(res.status).toBe(401);
    // Byte-identical: distinguishing these turns the endpoint into an oracle
    // that confirms a guessed or observed code was once real.
    expect(await res.json()).toEqual({ error: "invalid or expired handoff code" });
    expect(store.sessions).toHaveLength(0);
  });

  it("gives a replay the same answer as a code that never existed", async () => {
    seed();
    const first = await POST(request({ code: CODE }));
    expect(first.status).toBe(200);

    const replay = await POST(request({ code: CODE }));
    const unknown = await POST(request({ code: `trh_${"z".repeat(43)}` }));
    expect(replay.status).toBe(unknown.status);
    expect(await replay.json()).toEqual(await unknown.json());
    expect(store.sessions).toHaveLength(1);
  });

  it("lets a lifted ban through", async () => {
    seed({
      user: { email: "u@x", banned: true, banExpires: new Date(Date.now() - 60_000) },
    });
    const res = await POST(request({ code: CODE }));
    expect(res.status).toBe(200);
  });

  it("yields exactly one session when two redemptions race", async () => {
    seed();
    // Suspend the winner inside session creation, so the loser runs its whole
    // claim while the winner is mid-flight. A read-then-write handler would
    // see redeemedAt still unset and mint a second session here.
    let open!: () => void;
    mocks.sessionCreateGate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const both = Promise.all([POST(request({ code: CODE })), POST(request({ code: CODE }))]);
    await new Promise((resolve) => setImmediate(resolve));
    open();
    const [a, b] = await both;

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
    expect(store.sessions).toHaveLength(1);
    const winner = statuses[0] === 200 && a.status === 200 ? a : b;
    const { sessionToken } = (await winner.json()) as { sessionToken: string };
    expect(store.sessions[0].token).toBe(sessionToken);
    expect(store.handoffs[0].redeemedSessionId).toBe(store.sessions[0].id);
  });

  it("never stores the code, so a bad hash cannot be matched by value", async () => {
    const row = seed();
    // Only the random part is recased, so the value still has the minted shape
    // and is answered by the claim statement rather than by the format check
    // above it.
    const recased = `trh_${CODE.slice(4).toUpperCase()}`;
    const res = await POST(request({ code: recased }));

    expect(res.status).toBe(401);
    // The lookup is by digest: what the claim statement matched on is the hash
    // of the value sent, never the value. So a code that differs only in case
    // hashes somewhere else entirely and matches nothing -- there is no stored
    // copy of the code for it to be compared against.
    expect(store.claims).toBe(1);
    expect(store.claimedBy).toEqual([hashHandoffCode(recased)]);
    expect(store.claimedBy[0]).not.toBe(row.codeHash);
  });

  it("spends no hash and no query on a value that cannot be a minted code", async () => {
    seed();
    for (const code of [
      "trh_short",
      `trh_${"A".repeat(44)}`,
      `nope_${"A".repeat(42)}`,
      `trh_${"A".repeat(42)}+`,
      `trh_${"A".repeat(100_000)}`,
    ]) {
      const res = await POST(request({ code }));
      // Indistinguishable from a code that never existed: the shortcut saves
      // the work, not an answer an attacker could tell apart.
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid or expired handoff code" });
    }
    expect(store.claims).toBe(0);
    expect(store.handoffs[0].redeemedAt).toBeNull();

    // A code with the minted shape that is simply unknown still reaches the table.
    const unknown = await POST(request({ code: `trh_${"z".repeat(43)}` }));
    expect(unknown.status).toBe(401);
    expect(store.claims).toBe(1);
  });

  it("refuses a body larger than the one field it accepts, before reading it", async () => {
    seed();
    const res = await POST(request({ code: CODE }, { "content-length": "2048" }));
    expect(res.status).toBe(413);
    expect(store.claims).toBe(0);
    expect(store.handoffs[0].redeemedAt).toBeNull();
    expect(store.sessions).toHaveLength(0);
  });

  it("stops reading a body that declares no length once it passes the ceiling", async () => {
    seed();
    // A chunked request carries no content-length, so the declared-length
    // check cannot see it. Well-formed JSON, so a reader that buffered it all
    // would parse it and answer 401; 64 chunks of 512 bytes, so how many were
    // pulled shows where reading stopped.
    let pulled = 0;
    const chunks = ['{"code":"trh_', ...Array.from({ length: 64 }, () => "A".repeat(512)), '"}'];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[pulled++];
        if (next === undefined) controller.close();
        else controller.enqueue(encoder.encode(next));
      },
    });
    const chunked = new Request("http://localhost/api/cli/handoff/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "traceroot-cli/0.7.0" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(chunked.headers.get("content-length")).toBeNull();

    const res = await POST(chunked as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(6);
    expect(store.claims).toBe(0);
    expect(store.sessions).toHaveLength(0);
  });

  it("still redeems a code sent as a streamed body within the ceiling", async () => {
    seed();
    const streamed = new Request("http://localhost/api/cli/handoff/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "traceroot-cli/0.7.0" },
      body: JSON.stringify({ code: CODE }),
    });
    const res = await POST(streamed as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    expect(store.sessions).toHaveLength(1);
  });

  it("400s on a missing or malformed body", async () => {
    expect((await POST(request({}))).status).toBe(400);
    expect((await POST(request({ code: "" }))).status).toBe(400);
    expect((await POST(request("malformed"))).status).toBe(400);
  });

  it("rate limits tighter than the mint, on its own budget", async () => {
    mocks.rateLimitOk.mockReturnValue(false);
    seed();
    const res = await POST(request({ code: CODE }));
    expect(res.status).toBe(429);
    expect(mocks.rateLimitOk).toHaveBeenCalledWith("cli-handoff-redeem:test-client", 10, 60_000);
    expect(store.sessions).toHaveLength(0);
  });
});
