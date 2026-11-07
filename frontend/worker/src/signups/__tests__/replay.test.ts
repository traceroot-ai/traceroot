import { createHmac } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";

interface Row {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
  signupMethod: string | null;
  signupDeliveredAt: Date | null;
}

// The users table, and the filters replay.ts applies to it.
const table = vi.hoisted(() => ({ rows: [] as Row[], failUpdates: false }));
type Where = {
  AND?: { signupMethod: { not: string | null } }[];
  signupMethod?: null;
  signupDeliveredAt?: null;
  createdAt?: { lt: Date };
  id?: { gt?: string; in?: string[] } | string;
};
function matches(row: Row, where: Where): boolean {
  for (const clause of where.AND ?? []) {
    if (
      clause.signupMethod.not === null
        ? row.signupMethod === null
        : row.signupMethod === null || row.signupMethod === clause.signupMethod.not
    )
      return false;
  }
  if ("signupMethod" in where && row.signupMethod !== where.signupMethod) return false;
  if ("signupDeliveredAt" in where && row.signupDeliveredAt !== null) return false;
  if (where.createdAt && !(row.createdAt < where.createdAt.lt)) return false;
  if (typeof where.id === "string") return row.id === where.id;
  if (where.id?.gt !== undefined && !(row.id > where.id.gt)) return false;
  if (where.id?.in && !where.id.in.includes(row.id)) return false;
  return true;
}
const mocks = vi.hoisted(() => ({
  findMany: vi.fn(async ({ where, take }: { where: Where; take?: number }) =>
    table.rows
      .filter((row) => matches(row, where))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, take)
      .map((row) => ({ ...row })),
  ),
  updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
    if (table.failUpdates) throw new Error("database unavailable");
    const hit = table.rows.filter((row) => matches(row, where));
    for (const row of hit) Object.assign(row, data);
    return { count: hit.length };
  }),
  count: vi.fn(
    async ({ where }: { where: Where }) => table.rows.filter((row) => matches(row, where)).length,
  ),
}));
vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  return {
    ...actual,
    prisma: {
      user: { findMany: mocks.findMany, updateMany: mocks.updateMany, count: mocks.count },
    },
  };
});

import {
  backfillRunId,
  backfillSignups,
  countUnrecordedAccounts,
  parseUserIds,
  reconcileSignups,
} from "../replay.js";

const config = { url: "https://receiver.example.com/events", secret: "test-secret" };
const now = new Date("2026-11-09T03:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
const row = (id: string, overrides: Partial<Row> = {}): Row => ({
  id,
  email: `${id}@example.com`,
  name: null,
  createdAt: daysAgo(2),
  signupMethod: "email",
  signupDeliveredAt: null,
  ...overrides,
});
const accepted = () => new Response(null, { status: 202 });
const bodies = (fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) =>
  fetchImpl.mock.calls.map(([, init]) => JSON.parse(init?.body as string));
const sentIds = (fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) =>
  bodies(fetchImpl)
    .filter((body) => body.event === "user_signed_up")
    .map((body) => body.user.id);

beforeEach(() => {
  vi.clearAllMocks();
  table.rows = [];
  table.failUpdates = false;
});

it("replays an unacknowledged sign-up, never a staff-provisioned or unrecorded account", async () => {
  table.rows = [
    row("missed", { signupMethod: "google" }),
    row("acknowledged", { signupDeliveredAt: daysAgo(2) }),
    row("staff", { signupMethod: "admin" }),
    row("legacy", { signupMethod: null }),
    // Its live send may still be in flight.
    row("just-now", { createdAt: new Date(now.getTime() - 10 * 60 * 1000) }),
  ];
  const fetchImpl = vi.fn<typeof fetch>(async () => accepted());
  const result = await reconcileSignups({ now, config, send: true, fetchImpl });
  expect(sentIds(fetchImpl)).toEqual(["missed"]);
  expect(result).toMatchObject({ eligible: 1, sent: 1, failed: 0, summarySent: true });
  expect(await countUnrecordedAccounts()).toBe(1);
});

it("sends the recorded method and the run, signed, then a summary of the run", async () => {
  table.rows = [row("u1", { name: "A", createdAt: new Date("2026-03-01T10:00:00Z") })];
  const fetchImpl = vi.fn<typeof fetch>(async () => accepted());
  await reconcileSignups({ now, config, send: true, fetchImpl });
  expect(bodies(fetchImpl)).toEqual([
    {
      event: "user_signed_up",
      occurred_at: "2026-03-01T10:00:00.000Z",
      delivery: "reconcile",
      run_id: "reconcile-2026-11-09",
      user: { id: "u1", email: "u1@example.com", name: "A" },
      // Accepted invites are deleted, so a replay can't say.
      signup: { provider: "email", via_invite: null, utm: {} },
    },
    {
      event: "signups_replayed",
      occurred_at: expect.any(String),
      delivery: "reconcile",
      run_id: "reconcile-2026-11-09",
      user_ids: ["u1"],
    },
  ]);
  for (const [, init] of fetchImpl.mock.calls) {
    const headers = init?.headers as Record<string, string>;
    const expected = createHmac("sha256", "test-secret")
      .update(`${headers["X-TraceRoot-Timestamp"]}.${init?.body}`)
      .digest("hex");
    expect(headers["X-TraceRoot-Signature"]).toBe(expected);
  }
});

it("recovers sign-ups missed during an outage longer than any window, until each is acknowledged", async () => {
  table.rows = [row("a", { createdAt: daysAgo(45) }), row("b", { createdAt: daysAgo(30) })];
  const log = vi.fn();

  // The receiver is still down for one of them: the other is recorded.
  const partial = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValue(accepted());
  const first = await reconcileSignups({ now, config, send: true, fetchImpl: partial, log });
  expect(first).toMatchObject({ eligible: 2, sent: 1, failed: 1, summarySent: true });
  expect(log).toHaveBeenCalledWith(
    "[Signup replay] Sending user a failed: Sign-up webhook failed (503)",
  );
  expect(bodies(partial).at(-1)).toMatchObject({ user_ids: ["a", "b"] });

  // A restart the same day is the same run, and sends only what's left.
  const restart = vi.fn<typeof fetch>(async () => accepted());
  const second = await reconcileSignups({ now, config, send: true, fetchImpl: restart });
  expect(sentIds(restart)).toEqual(["a"]);
  expect(second.runId).toBe(first.runId);

  // Once everything is acknowledged, a later run has nothing to send.
  const later = vi.fn<typeof fetch>(async () => accepted());
  const third = await reconcileSignups({ now: daysAgo(-7), config, send: true, fetchImpl: later });
  expect(third).toMatchObject({ runId: "reconcile-2026-11-16", eligible: 0, sent: 0 });
  expect(sentIds(later)).toEqual([]);
});

it("sends a sign-up again when it was delivered but not recorded", async () => {
  table.rows = [row("u1")];
  table.failUpdates = true;
  const log = vi.fn();
  const fetchImpl = vi.fn<typeof fetch>(async () => accepted());
  await reconcileSignups({ now, config, send: true, fetchImpl, log });
  expect(log).toHaveBeenCalledWith(
    "[Signup replay] Recording user u1 as delivered failed: database unavailable",
  );
  table.failUpdates = false;
  const retry = vi.fn<typeof fetch>(async () => accepted());
  await reconcileSignups({ now, config, send: true, fetchImpl: retry });
  expect(sentIds(retry)).toEqual(["u1"]);
});

it("backfills only an approved list, reporting an unrecorded method as unknown", async () => {
  table.rows = [
    // Signed up with email, linked Google later: nothing recorded says which came first.
    row("legacy", { signupMethod: null }),
    row("recorded", { signupMethod: "google" }),
    row("staff", { signupMethod: "admin" }),
    row("unlisted", { signupMethod: null }),
  ];
  const fetchImpl = vi.fn<typeof fetch>(async () => accepted());
  const userIds = ["legacy", "recorded", "staff", "gone"];
  const result = await backfillSignups({ userIds, config, send: true, fetchImpl });
  expect(result).toMatchObject({
    runId: backfillRunId(userIds),
    eligible: 2,
    sent: 2,
    excluded: 1,
    notFound: 1,
    byProvider: { unknown: 1, google: 1 },
  });
  const [legacy, recorded, summary] = bodies(fetchImpl);
  expect(legacy).toMatchObject({
    delivery: "backfill",
    user: { id: "legacy" },
    signup: { provider: "unknown", via_invite: null },
  });
  expect(recorded).toMatchObject({ signup: { provider: "google" } });
  expect(summary).toMatchObject({ event: "signups_replayed", user_ids: ["legacy", "recorded"] });
});

it("resumes an interrupted backfill as the same run, without resending what was acknowledged", async () => {
  table.rows = [row("a", { signupMethod: null }), row("b", { signupMethod: null })];
  const failing = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(accepted())
    .mockRejectedValue(new Error("connection reset"));
  const first = await backfillSignups({
    userIds: ["a", "b"],
    config,
    send: true,
    fetchImpl: failing,
    log: () => {},
  });
  const resume = vi.fn<typeof fetch>(async () => accepted());
  const second = await backfillSignups({
    userIds: ["b", "a", "a"],
    config,
    send: true,
    fetchImpl: resume,
  });
  expect(second.runId).toBe(first.runId);
  expect(sentIds(resume)).toEqual(["b"]);
  expect(second).toMatchObject({ eligible: 2, alreadyDelivered: 1, sent: 1 });
  // The summary still lists both, so the receiver's report covers the whole list.
  expect(bodies(resume).at(-1)).toMatchObject({ user_ids: ["b", "a"] });
});

it("counts what a dry run would send, and sends or records nothing", async () => {
  table.rows = [row("u1"), row("u2", { signupMethod: "google" })];
  const fetchImpl = vi.fn<typeof fetch>();
  const result = await reconcileSignups({ now, config, send: false, fetchImpl });
  expect(result).toMatchObject({
    eligible: 2,
    sent: 0,
    summarySent: false,
    byProvider: { email: 1, google: 1 },
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(mocks.updateMany).not.toHaveBeenCalled();
});

it("counts nothing as sent when the webhook isn't configured", async () => {
  table.rows = [row("u1")];
  const fetchImpl = vi.fn<typeof fetch>();
  const result = await reconcileSignups({
    now,
    config: { url: config.url },
    send: true,
    fetchImpl,
    log: () => {},
  });
  expect(result).toMatchObject({ sent: 0, failed: 1, summarySent: false });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(table.rows[0]!.signupDeliveredAt).toBeNull();
});

it("pages through sign-ups by ID, past users that leave the filter as they're sent", async () => {
  table.rows = Array.from({ length: 501 }, (_, i) => row(`u${String(i).padStart(4, "0")}`));
  const fetchImpl = vi.fn<typeof fetch>(async () => accepted());
  const result = await reconcileSignups({ now, config, send: true, fetchImpl });
  expect(result.sent).toBe(501);
  expect(mocks.findMany.mock.calls[1]![0]).toMatchObject({ where: { id: { gt: "u0499" } } });
});

it("reads one user ID per line from a backfill list", () => {
  expect(parseUserIds("u1\n\n  u2  # created 2026-01-01\n# header\nu3\n")).toEqual([
    "u1",
    "u2",
    "u3",
  ]);
});
