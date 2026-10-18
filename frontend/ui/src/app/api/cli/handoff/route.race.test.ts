import { describe, expect, it, vi } from "vitest";

/**
 * Two overlapping mints for one user -- two onboarding tabs, or the refresh
 * timer firing as a second tab mounts -- against a model of the two Postgres
 * properties the outcome turns on, since no database runs in this suite:
 *
 *   - READ COMMITTED: a statement acts only on rows committed before it began,
 *     so a row another open transaction has inserted is invisible to this
 *     one's delete.
 *   - pg_advisory_xact_lock: a mutex per key, held until the transaction that
 *     took it commits.
 *
 * Every statement yields before it returns, so the two transactions interleave
 * the way two connections can. Without the lock both deletes find nothing and
 * both inserts commit: two live codes, where the route promises one.
 */

type Row = { id: string; userId: string; codeHash: string; redeemedAt: Date | null };

const db = vi.hoisted(() => ({
  committed: [] as Row[],
  locks: new Map<string, Promise<void>>(),
  seq: 0,
}));

const otherConnection = () => new Promise<void>((resolve) => setImmediate(resolve));

async function transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
  const inserted: Row[] = [];
  const deleted = new Set<string>();
  const releases: (() => void)[] = [];
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const key = `${strings.join("?")}|${values.join("|")}`;
      while (db.locks.has(key)) await db.locks.get(key);
      db.locks.set(
        key,
        new Promise<void>((resolve) =>
          releases.push(() => {
            db.locks.delete(key);
            resolve();
          }),
        ),
      );
      return 1;
    },
    cliHandoff: {
      deleteMany: async ({ where }: { where: { userId: string; redeemedAt: null } }) => {
        const visible = db.committed.filter(
          (row) => row.userId === where.userId && row.redeemedAt === null,
        );
        await otherConnection();
        for (const row of visible) deleted.add(row.id);
        return { count: visible.length };
      },
      create: async ({ data }: { data: Omit<Row, "id" | "redeemedAt"> }) => {
        await otherConnection();
        const row = { ...data, id: `handoff-${++db.seq}`, redeemedAt: null };
        inserted.push(row);
        return { ...row, expiresAt: new Date(Date.now() + 600_000) };
      },
    },
  };
  try {
    const result = await fn(tx);
    db.committed = db.committed.filter((row) => !deleted.has(row.id)).concat(inserted);
    return result;
  } finally {
    for (const release of releases) release();
  }
}

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("@/env", () => ({ env: { BETTER_AUTH_URL: "https://app.traceroot.ai/" } }));
vi.mock("@/lib/request-session", () => ({
  getRequestSession: async () => ({
    user: { id: "u1", email: "u@example.com", name: null },
    session: { id: "browser-session" },
  }),
}));
vi.mock("@/lib/mint-rate-limit", () => ({
  checkMintRateLimit: () => true,
  rateLimitClientKey: () => "test-client",
}));
vi.mock("@traceroot/core", () => ({
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
  hasMinRole: () => true,
  prisma: {
    project: { findUnique: async () => ({ id: "p1", workspaceId: "w1", name: "Proj" }) },
    workspaceMember: {
      findUnique: async () => ({ workspaceId: "w1", userId: "u1", role: "MEMBER" }),
    },
    // The expiry sweep, after the mint; nothing here is old enough to sweep.
    cliHandoff: { deleteMany: async () => ({ count: 0 }) },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => transaction(fn),
  },
}));

import { hashHandoffCode } from "@/lib/cli-handoff";
import { POST } from "./route";

function request() {
  return {
    headers: new Headers({ origin: "https://app.traceroot.ai" }),
    json: async () => ({ projectId: "p1" }),
  } as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/cli/handoff under overlapping mints", () => {
  it("leaves exactly one live code for the user", async () => {
    const responses = await Promise.all([POST(request()), POST(request())]);
    const codes = await Promise.all(
      responses.map(async (res) => ((await res.json()) as { code: string }).code),
    );
    expect(responses.map((res) => res.status)).toEqual([200, 200]);

    const live = db.committed.filter((row) => row.userId === "u1" && row.redeemedAt === null);
    expect(live).toHaveLength(1);
    expect(codes.map(hashHandoffCode)).toContain(live[0].codeHash);
    expect(db.locks.size).toBe(0);
  });
});
