import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { testDb as db } from "./trace-count-test-db";

/**
 * The daily trace_count through the real PostHog sender against an HTTP endpoint
 * standing in for PostHog: one owner's delivery fails and another's succeeds, each
 * answered on its own request, and the next tick retries only the owner still due.
 */

vi.mock("@traceroot/core", async () => ({
  prisma: (await import("./trace-count-test-db")).testDb.prisma,
  Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
}));
const clientEnv = vi.hoisted(() => ({
  NEXT_PUBLIC_POSTHOG_KEY: "phc_test",
  NEXT_PUBLIC_POSTHOG_HOST: "",
}));
vi.mock("@/env.client", () => ({ clientEnv }));

/** What the endpoint received, in order, and whose deliveries it refuses. */
const received: { distinctId: string; traceCount: number; status: number }[] = [];
const refused = new Set<string>();
let server: Server;
let reportDailyTraceCounts: typeof import("./trace-count").reportDailyTraceCounts;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const [event] = JSON.parse(body).batch;
      const status = refused.has(event.distinct_id) ? 503 : 200;
      received.push({
        distinctId: event.distinct_id,
        traceCount: event.properties.$set.trace_count,
        status,
      });
      res.writeHead(status, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  clientEnv.NEXT_PUBLIC_POSTHOG_HOST = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ({ reportDailyTraceCounts } = await import("./trace-count"));
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  for (const table of Object.values(db.tables)) table.length = 0;
  received.length = 0;
  refused.clear();
  for (const [id, traces] of [
    ["user_ada", 10],
    ["user_sam", 20],
  ] as const) {
    db.tables.users.push({ id });
    db.tables.workspaces.push({ id: `ws_${id}`, createdBy: id, currentUsage: { traces } });
  }
});

const NOV_18 = new Date("2026-11-18T09:00:00Z");
const NOV_18_DAY = new Date("2026-11-18T00:00:00Z");
const later = (minutes: number) => new Date(NOV_18.getTime() + minutes * 60_000);
const row = (userId: string) => db.tables.onboarding.find((r) => r.userId === userId);

it("retries only the owner whose delivery failed, on the next tick", async () => {
  refused.add("user_ada");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    expect(await reportDailyTraceCounts(() => NOV_18)).toEqual({
      kind: "sent",
      sent: 1,
      remaining: 1,
    });
  } finally {
    logged.mockRestore();
  }
  expect(received).toEqual([
    { distinctId: "user_ada", traceCount: 10, status: 503 },
    { distinctId: "user_sam", traceCount: 20, status: 200 },
  ]);
  expect(row("user_ada")).toMatchObject({ traceCountReportedOn: null });
  expect(row("user_sam")).toMatchObject({ traceCountReportedOn: NOV_18_DAY });

  // PostHog accepts again; the next tick sends Ada and nobody else.
  refused.clear();
  expect(await reportDailyTraceCounts(() => later(15))).toEqual({
    kind: "sent",
    sent: 1,
    remaining: 0,
  });
  expect(received.slice(2)).toEqual([{ distinctId: "user_ada", traceCount: 10, status: 200 }]);
  expect(row("user_ada")).toMatchObject({ traceCountReportedOn: NOV_18_DAY });

  // Nothing is due any more today.
  expect(await reportDailyTraceCounts(() => later(30))).toEqual({
    kind: "sent",
    sent: 0,
    remaining: 0,
  });
  expect(received).toHaveLength(3);
});
