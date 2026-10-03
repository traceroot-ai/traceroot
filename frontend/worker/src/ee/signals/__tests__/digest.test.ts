import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockAdd, mockRecipients, mockSlack, mockEmail, mockAlertConfig } = vi.hoisted(() => ({
  mockAdd: vi.fn(),
  mockRecipients: vi.fn(),
  mockSlack: vi.fn(),
  mockEmail: vi.fn(),
  mockAlertConfig: vi.fn(),
}));
vi.mock("../../../notifications/digest-schedule.js", () => ({
  getDigestQueue: () => ({ add: mockAdd }),
  // The real token table is in core; these are the windows the tests use.
  alertWindowMs: (w: string | null | undefined) =>
    ({ "1m": 60_000, "30m": 1_800_000 })[w ?? ""] ?? 600_000,
}));
vi.mock("../../../notifications/digest-recipients.js", () => ({
  resolveRecipients: mockRecipients,
}));
vi.mock("../../../notifications/slack.js", () => ({ postSlackMessage: mockSlack }));
vi.mock("../../../notifications/email.js", () => ({ sendEmail: mockEmail }));
vi.mock("@traceroot/core", () => ({
  prisma: { detectorAlertConfig: { findUnique: mockAlertConfig } },
  escapeHtml: (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  renderEmailCard: (p: { title: string; bodyHtml: string }) =>
    `<card>${p.title}${p.bodyHtml}</card>`,
}));

import {
  enqueueSignalDigest,
  flushSignalDigest,
  loadDigestInput,
  planSignalDigest,
  recordDigest,
  sweepSignalDigests,
  type OpeningRca,
  type PendingSignal,
} from "../digest.js";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const MIN = 60_000;

const sig = (over: Partial<PendingSignal> = {}): PendingSignal => ({
  id: "s1",
  title: "Timeout swallowed",
  detectorId: "d1",
  status: "open",
  hitCount: 3,
  runIds: ["r1", "r2", "r3"],
  reopenSeq: 0,
  notifiedReopenSeq: null,
  notifiedHitCount: 0,
  mergedIntoId: null,
  ...over,
});
const detectors = new Map([["d1", "Failure"]]);
const plan = (signals: PendingSignal[], rcas: [string, Omit<OpeningRca, "reopenSeq">][] = []) => {
  const bySignal = new Map<string, OpeningRca[]>();
  for (const [key, rca] of rcas) {
    const [signalId, seq] = key.split(":");
    bySignal.set(signalId, [...(bySignal.get(signalId) ?? []), { ...rca, reopenSeq: Number(seq) }]);
  }
  return planSignalDigest({ signals, groupingDetectors: detectors, rcas: bySignal });
};
/** An opening's RCA: the latest attempt's status, and the answer kept on the opening. */
const rca = (status: string, rootCause?: string | null): Omit<OpeningRca, "reopenSeq"> => ({
  status,
  answered: rootCause !== undefined,
  rootCause: rootCause ?? null,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENAI_API_KEY", "sk");
  mockAdd.mockResolvedValue(undefined);
  mockSlack.mockResolvedValue(true);
  mockEmail.mockResolvedValue(true);
  mockAlertConfig.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("planSignalDigest", () => {
  it("announces a new signal with the root cause its RCA kept", () => {
    const p = plan([sig()], [["s1:0", rca("done", "swallowed timeout")]]);
    expect(p.items).toEqual([
      expect.objectContaining({
        kind: "new",
        signalId: "s1",
        detectorName: "Failure",
        hitCount: 3,
        rca: { state: "done", rootCause: "swallowed timeout" },
      }),
    ]);
    expect(p.consumed).toEqual([
      { id: "s1", reopenSeq: 0, hitCount: 3, runIds: ["r1", "r2", "r3"], sent: true },
    ]);
  });

  it("announces a new signal without waiting for its RCA, saying it is still running", () => {
    for (const status of ["pending", "running"]) {
      const p = plan([sig()], [["s1:0", rca(status)]]);
      expect(p.items[0]).toMatchObject({ kind: "new", rca: { state: "running", rootCause: null } });
      expect(p.consumed.map((c) => c.sent)).toEqual([true]);
    }
  });

  it("announces at once when no RCA was due (RCA off, or within the cooldown)", () => {
    expect(plan([sig()]).items[0]).toMatchObject({ kind: "new", rca: null });
  });

  it("keeps an earlier answer when a later attempt on the shared finding fails or is pending", () => {
    // The opening kept its answer; the finding's latest attempt failed since.
    const p = plan([sig()], [["s1:0", { status: "failed", answered: true, rootCause: "kept" }]]);
    expect(p.items[0].rca).toEqual({ state: "done", rootCause: "kept" });
  });

  it("announces a reopening with the newest opening's RCA since the last announcement", () => {
    const s = sig({ reopenSeq: 2, notifiedReopenSeq: 0, notifiedHitCount: 3, hitCount: 5 });
    expect(plan([s], [["s1:1", rca("running")]]).items[0]).toMatchObject({
      kind: "reopened",
      rca: { state: "running" },
    });
    expect(plan([s], [["s1:1", rca("done", "late")]]).items[0]).toMatchObject({
      kind: "reopened",
      rca: { state: "done", rootCause: "late" },
    });
    // An RCA from an opening already announced is not this announcement's.
    expect(plan([s], [["s1:0", rca("running")]]).items[0]).toMatchObject({
      kind: "reopened",
      rca: null,
    });
  });

  it("reuses the kept canonical answer for a reopening inside the cooldown", () => {
    const p = plan(
      [sig({ reopenSeq: 1, notifiedReopenSeq: 0, notifiedHitCount: 2 })],
      [["s1:0", rca("done", "original cause")]],
    );
    expect(p.items[0]).toMatchObject({
      kind: "reopened",
      rca: { state: "done", rootCause: "original cause" },
    });
  });

  it("labels a reopening, and reports a failed RCA", () => {
    const p = plan(
      [sig({ reopenSeq: 2, notifiedReopenSeq: 1, notifiedHitCount: 3, hitCount: 4 })],
      [["s1:2", rca("failed")]],
    );
    expect(p.items[0]).toMatchObject({ kind: "reopened", hitCount: 4, rca: { state: "failed" } });
  });

  it("counts more hits on an announced signal silently", () => {
    const p = plan([
      sig(),
      sig({ id: "s2", notifiedReopenSeq: 0, notifiedHitCount: 10, hitCount: 14 }),
    ]);
    expect(p.items.map((i) => [i.signalId, i.kind])).toEqual([["s1", "new"]]);
    expect(p.consumed.map((c) => [c.id, c.sent, c.hitCount])).toEqual([
      ["s1", true, 3],
      ["s2", false, 14],
    ]);
    expect(plan([sig({ notifiedReopenSeq: 0, notifiedHitCount: 1, hitCount: 5 })]).items).toEqual(
      [],
    );
  });

  it("counts dismissed, resolved, merged and no-longer-grouping signals silently", () => {
    const p = plan([
      sig({ id: "a", status: "dismissed" }),
      sig({ id: "b", status: "resolved" }),
      sig({ id: "c", mergedIntoId: "x" }),
      sig({ id: "d", detectorId: "switched-off" }),
    ]);
    expect(p.items).toEqual([]);
    expect(p.consumed.map((c) => [c.id, c.sent])).toEqual([
      ["a", false],
      ["b", false],
      ["c", false],
      ["d", false],
    ]);
  });

  it("records a drop in hits (a hit moved away) without reporting it", () => {
    const p = plan([sig({ notifiedReopenSeq: 0, notifiedHitCount: 5, hitCount: 4 })]);
    expect(p.items).toEqual([]);
    expect(p.consumed).toEqual([
      { id: "s1", reopenSeq: 0, hitCount: 4, runIds: ["r1", "r2", "r3"], sent: false },
    ]);
  });
});

function fakeDb(signals: PendingSignal[]) {
  const updates: unknown[] = [];
  const raws: { sql: string; values: unknown[] }[] = [];
  const queries: string[] = [];
  const db = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      queries.push(sql);
      if (sql.includes("SELECT DISTINCT signal_id")) return [{ signalId: "moved-target" }];
      if (sql.includes("GROUP BY s.project_id"))
        return [
          // Default 10-minute window: due after 11 minutes, not after 5.
          { projectId: "p1", oldest: new Date(T0 - 11 * MIN), alertWindow: null },
          { projectId: "p2", oldest: new Date(T0 - 5 * MIN), alertWindow: null },
          // A 1-minute window: due after 2 minutes.
          { projectId: "p3", oldest: new Date(T0 - 2 * MIN), alertWindow: "1m" },
        ];
      return signals;
    }),
    $executeRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const op = { sql: strings.join("?"), values };
      raws.push(op);
      if (op.sql.includes("SET notified_reopen_seq")) updates.push(op);
      return op;
    }),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    detector: {
      findMany: vi.fn(async () => [
        { id: "d1", name: "Failure", enableSignals: true },
        { id: "d2", name: "Logic", enableSignals: false },
      ]),
    },
    signalRca: {
      findMany: vi.fn(async () => [
        {
          signalId: "s1",
          reopenSeq: 0,
          result: "### 1. Failure\n- Root cause: swallowed",
          rootCause: "swallowed",
          rca: { status: "failed" },
        },
      ]),
    },
    signal: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        signals
          .filter((s) => where.id.in.includes(s.id))
          .map((s) => ({ projectId: "p1", detectorId: s.detectorId })),
      ),
    },
    signalHit: {
      findMany: vi.fn(async () => [{ signalId: "moved-target" }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  return { db, updates, raws, queries };
}

describe("loadDigestInput", () => {
  it("reads unreported signals, grouping detectors, and each opening's kept answer", async () => {
    const { db, queries } = fakeDb([sig(), sig({ id: "s2", detectorId: "d2" })]);
    const input = await loadDigestInput(db as never, "p1");
    expect(queries[0]).toContain("notified_reopen_seq IS DISTINCT FROM reopen_seq");
    expect([...input.groupingDetectors]).toEqual([["d1", "Failure"]]);
    // The kept answer outlives a later failed attempt on the shared finding.
    expect(input.rcas.get("s1")).toEqual([
      { reopenSeq: 0, status: "failed", answered: true, rootCause: "swallowed" },
    ]);
  });

  it("treats every detector as not grouping without the signals key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { db } = fakeDb([sig()]);
    expect((await loadDigestInput(db as never, "p1")).groupingDetectors.size).toBe(0);
  });
});

describe("recordDigest", () => {
  it("marks only the snapshot hits, follows moves, and recounts their current owners", async () => {
    const { db, raws } = fakeDb([
      sig({ id: "a", detectorId: "d2" }),
      sig({ id: "b", detectorId: "d1" }),
      sig({ id: "unconsumed", detectorId: "d3" }),
    ]);
    await recordDigest(
      db as never,
      {
        items: [],
        consumed: [
          { id: "a", reopenSeq: 1, hitCount: 7, runIds: ["reported-before-move"], sent: true },
          { id: "b", reopenSeq: 0, hitCount: 2, runIds: ["silent"], sent: false },
        ],
      },
      new Date(T0),
    );
    expect(raws.find((r) => r.sql.includes("UPDATE signal_hits"))).toEqual({
      sql: expect.stringContaining("AND reported_at IS NULL"),
      values: [new Date(T0), ["reported-before-move", "silent"]],
    });
    expect(
      raws.filter((r) => r.sql.includes("pg_advisory_xact_lock")).map((r) => r.values),
    ).toEqual([
      ["p1", "d1"],
      ["p1", "d2"],
    ]);
    expect(
      raws.filter((r) => r.sql.includes("SET notified_reopen_seq")).map((r) => r.values),
    ).toEqual([
      [1, true, new Date(T0), "a"],
      [0, false, new Date(T0), "b"],
    ]);
    expect(raws.at(-1)).toEqual({
      sql: expect.stringContaining("h.reported_at IS NOT NULL"),
      values: [["a", "b", "moved-target"]],
    });
  });
});

describe("flushSignalDigest", () => {
  const recipients = {
    projectName: "Shop",
    workspaceId: "ws",
    slackChannelId: "C1",
    encryptedBotToken: "enc",
    emailAddresses: ["a@example.com"],
  };

  it("sends to Slack and email, then records what it reported", async () => {
    mockRecipients.mockResolvedValue(recipients);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, updates } = fakeDb([sig()]);
    const p = await flushSignalDigest("p1", T0, db as never);
    expect(p?.items).toHaveLength(1);
    expect(mockSlack).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "C1", text: "Signals in Shop: 1 new" }),
    );
    expect(mockEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["a@example.com"],
        subject: "[TraceRoot] Signals in Shop: 1 new",
      }),
    );
    expect(updates).toHaveLength(1);
    log.mockRestore();
  });

  it("records changes without sending when the project has no channels", async () => {
    mockRecipients.mockResolvedValue(null);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, updates } = fakeDb([sig()]);
    await flushSignalDigest("p1", T0, db as never);
    expect(mockSlack).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    log.mockRestore();
  });

  it("keeps going when one channel fails", async () => {
    mockRecipients.mockResolvedValue(recipients);
    mockSlack.mockRejectedValue(new Error("slack down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, updates } = fakeDb([sig()]);
    await flushSignalDigest("p1", T0, db as never);
    expect(mockEmail).toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    error.mockRestore();
    log.mockRestore();
  });

  it("leaves the changes unreported when every send fails, for the sweeper to retry", async () => {
    mockRecipients.mockResolvedValue(recipients);
    mockSlack.mockRejectedValue(new Error("slack down"));
    mockEmail.mockRejectedValue(new Error("smtp down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, updates } = fakeDb([sig()]);
    await flushSignalDigest("p1", T0, db as never);
    expect(updates).toHaveLength(0);
    error.mockRestore();
    log.mockRestore();
  });

  it("records the changes when no channel is set up to deliver (no SMTP, no Slack plan)", async () => {
    mockRecipients.mockResolvedValue(recipients);
    mockSlack.mockResolvedValue(false);
    mockEmail.mockResolvedValue(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, updates } = fakeDb([sig()]);
    await flushSignalDigest("p1", T0, db as never);
    expect(updates).toHaveLength(1);
    log.mockRestore();
  });

  it("does nothing when no signal changed", async () => {
    const { db } = fakeDb([]);
    expect(await flushSignalDigest("p1", T0, db as never)).toBe(null);
    expect(mockRecipients).not.toHaveBeenCalled();
  });
});

describe("scheduling", () => {
  it("enqueues one digest job per project, one notification window out", async () => {
    await enqueueSignalDigest("p1");
    expect(mockAlertConfig).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "p1" } }),
    );
    expect(mockAdd).toHaveBeenCalledWith(
      "signal-digest-p1",
      { kind: "signals", projectId: "p1" },
      expect.objectContaining({
        jobId: "signal-digest-p1",
        delay: 600_000,
        removeOnComplete: true,
      }),
    );
  });

  it("uses the project's alert window when one is set", async () => {
    mockAlertConfig.mockResolvedValue({ alertWindow: "30m" });
    await enqueueSignalDigest("p1");
    expect(mockAdd.mock.calls[0][2].delay).toBe(1_800_000);
  });

  it("sweeps projects whose oldest unreported change is older than their window", async () => {
    const { db, queries } = fakeDb([]);
    expect(await sweepSignalDigests(db as never, T0)).toBe(2);
    expect(queries[0]).toContain("detector_alert_configs");
    expect(mockAdd.mock.calls.map((c) => [c[1].projectId, c[2].delay])).toEqual([
      ["p1", 0],
      ["p3", 0],
    ]);
  });
});
