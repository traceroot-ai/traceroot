import { createHmac } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindMany: vi.fn(),
}));
vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  return {
    ...actual,
    prisma: { user: { findMany: mocks.userFindMany } },
  };
});

import { providerOf, reconcileWindow, replaySignups } from "../replay.js";

const config = { url: "https://receiver.example.com/events", secret: "test-secret" };
const users = [
  {
    id: "u1",
    email: "a@example.com",
    name: "A",
    createdAt: new Date("2026-03-01T10:00:00Z"),
    accounts: [{ providerId: "credential" }],
  },
  {
    id: "u2",
    email: "B@Example.com",
    name: null,
    createdAt: new Date("2026-03-02T10:00:00Z"),
    accounts: [{ providerId: "google" }],
  },
];
const from = new Date(0);
const to = new Date("2026-11-06T16:00:00Z");
const accepted = () => new Response(null, { status: 202 });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindMany.mockResolvedValue(users);
});

it("counts what a dry run would send, and sends nothing", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const result = await replaySignups({
    delivery: "backfill",
    from,
    to,
    config,
    send: false,
    fetchImpl,
  });
  expect(result).toEqual({
    eligible: 2,
    sent: 0,
    failed: 0,
    summarySent: false,
    byProvider: { email: 1, google: 1 },
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(mocks.userFindMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { createdAt: { gte: from, lt: to } } }),
  );
});

it("sends each sign-up with its original time and method, then a signed summary of all of them", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => accepted());
  const result = await replaySignups({
    delivery: "backfill",
    from,
    to,
    config,
    send: true,
    fetchImpl,
  });
  expect(result).toMatchObject({ eligible: 2, sent: 2, failed: 0, summarySent: true });
  const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init?.body as string));
  expect(bodies).toEqual([
    {
      event: "user_signed_up",
      occurred_at: "2026-03-01T10:00:00.000Z",
      delivery: "backfill",
      user: { id: "u1", email: "a@example.com", name: "A" },
      // Accepted invites are deleted, so a replay can't say.
      signup: { provider: "email", via_invite: null, utm: {} },
    },
    {
      event: "user_signed_up",
      occurred_at: "2026-03-02T10:00:00.000Z",
      delivery: "backfill",
      user: { id: "u2", email: "B@Example.com", name: null },
      signup: { provider: "google", via_invite: null, utm: {} },
    },
    {
      event: "signups_replayed",
      occurred_at: expect.any(String),
      delivery: "backfill",
      window: { from: from.toISOString(), to: to.toISOString() },
      user_ids: ["u1", "u2"],
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

it("keeps going past a failed send, and still sends the summary listing it", async () => {
  const log = vi.fn();
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValue(accepted());
  const result = await replaySignups({
    delivery: "reconcile",
    from,
    to,
    config,
    send: true,
    fetchImpl,
    log,
  });
  expect(result).toMatchObject({ eligible: 2, sent: 1, failed: 1, summarySent: true });
  expect(log).toHaveBeenCalledWith(
    "[Signup replay] Sending user u1 failed: Sign-up webhook failed (503)",
  );
  const summary = JSON.parse(fetchImpl.mock.calls.at(-1)![1]?.body as string);
  expect(summary).toMatchObject({ event: "signups_replayed", user_ids: ["u1", "u2"] });
});

it("still returns the counts when the summary itself fails", async () => {
  const log = vi.fn();
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(accepted())
    .mockResolvedValueOnce(accepted())
    .mockResolvedValueOnce(new Response(null, { status: 413 }));
  const result = await replaySignups({
    delivery: "backfill",
    from,
    to,
    config,
    send: true,
    fetchImpl,
    log,
  });
  expect(result).toMatchObject({ sent: 2, failed: 0, summarySent: false });
  expect(log).toHaveBeenCalledWith(
    "[Signup replay] Sending the summary failed: Sign-up webhook failed (413)",
  );
});

it("counts nothing as sent when the webhook isn't configured", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const result = await replaySignups({
    delivery: "reconcile",
    from,
    to,
    config: { url: config.url },
    send: true,
    fetchImpl,
    log: () => {},
  });
  expect(result).toMatchObject({ sent: 0, failed: 2, summarySent: false });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("pages through users without loading them all at once", async () => {
  const page = Array.from({ length: 500 }, (_, i) => ({ ...users[0]!, id: `p${i}` }));
  mocks.userFindMany.mockResolvedValueOnce(page).mockResolvedValueOnce([users[1]]);
  const result = await replaySignups({ delivery: "backfill", from, to, config, send: false });
  expect(result.eligible).toBe(501);
  expect(mocks.userFindMany.mock.calls[1]![0]).toMatchObject({ skip: 1, cursor: { id: "p499" } });
});

it("reports email sign-ups as email, like the live hook", () => {
  expect(providerOf("credential")).toBe("email");
  expect(providerOf("Google")).toBe("google");
  expect(providerOf(undefined)).toBe("unknown");
});

it("covers the two weeks up to an hour ago", () => {
  expect(reconcileWindow(new Date("2026-11-09T03:00:00Z"), 14)).toEqual({
    from: new Date("2026-10-26T02:00:00Z"),
    to: new Date("2026-11-09T02:00:00Z"),
  });
});
