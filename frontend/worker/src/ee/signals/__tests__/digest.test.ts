import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockAdd, mockRecipients, mockSlack, mockEmail } = vi.hoisted(() => ({
  mockAdd: vi.fn(),
  mockRecipients: vi.fn(),
  mockSlack: vi.fn(),
  mockEmail: vi.fn(),
}));
vi.mock("../../../notifications/digest-schedule.js", () => ({
  getDigestQueue: () => ({ add: mockAdd }),
}));
vi.mock("../../../notifications/digest-recipients.js", () => ({
  resolveRecipients: mockRecipients,
}));
vi.mock("../../../notifications/slack.js", () => ({ postSlackMessage: mockSlack }));
vi.mock("../../../notifications/email.js", () => ({ sendEmail: mockEmail }));
vi.mock("@traceroot/core", () => ({
  prisma: {},
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
  rootCauseLine,
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
  reopenSeq: 0,
  notifiedReopenSeq: null,
  notifiedHitCount: 0,
  mergedIntoId: null,
  ...over,
});
const detectors = new Map([["d1", "Failure"]]);
const plan = (
  signals: PendingSignal[],
  rcas: [string, Omit<OpeningRca, "reopenSeq">][] = [],
  lastSentAt: number | null = null,
) => {
  const bySignal = new Map<string, OpeningRca[]>();
  for (const [key, rca] of rcas) {
    const [signalId, seq] = key.split(":");
    bySignal.set(signalId, [...(bySignal.get(signalId) ?? []), { ...rca, reopenSeq: Number(seq) }]);
  }
  return planSignalDigest({
    signals,
    groupingDetectors: detectors,
    rcas: bySignal,
    lastSentAt,
    now: T0,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENAI_API_KEY", "sk");
  mockAdd.mockResolvedValue(undefined);
  mockSlack.mockResolvedValue(true);
  mockEmail.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe("rootCauseLine", () => {
  const sectioned =
    "### 1. Failure\n- Root cause: the timeout is swallowed\n- Code location: a.py:3\n\n" +
    "### 2. Logic\n- **Root cause:** the city is copied from the wrong field\n";
  it("takes the root cause from the section naming the detector", () => {
    expect(rootCauseLine(sectioned, "Logic")).toBe("the city is copied from the wrong field");
    expect(rootCauseLine(sectioned, "Failure")).toBe("the timeout is swallowed");
  });
  it("falls back to the first root cause, and to null", () => {
    expect(rootCauseLine("- Root cause: one cause", "Other")).toBe("one cause");
    expect(rootCauseLine("no structure", "Other")).toBe(null);
  });
});

describe("planSignalDigest", () => {
  it("announces a new signal once its RCA is done, with the root cause", () => {
    const p = plan(
      [sig()],
      [
        [
          "s1:0",
          {
            status: "done",
            result: "- Root cause: swallowed timeout",
            createTime: new Date(T0 - MIN),
          },
        ],
      ],
    );
    expect(p.items).toEqual([
      expect.objectContaining({
        kind: "new",
        signalId: "s1",
        detectorName: "Failure",
        hitCount: 3,
        rca: { state: "done", rootCause: "swallowed timeout" },
      }),
    ]);
    expect(p.consumed).toEqual([{ id: "s1", reopenSeq: 0, hitCount: 3, sent: true }]);
  });

  it("holds a new signal while its RCA runs, for up to thirty minutes", () => {
    const running = (age: number): [string, Omit<OpeningRca, "reopenSeq">] => [
      "s1:0",
      { status: "running", result: null, createTime: new Date(T0 - age) },
    ];
    expect(plan([sig()], [running(5 * MIN)]).items).toEqual([]);
    expect(plan([sig()], [running(5 * MIN)]).consumed).toEqual([]);
    expect(plan([sig()], [running(31 * MIN)]).items[0].rca).toEqual({
      state: "running",
      rootCause: null,
    });
  });

  it("announces at once when no RCA was due (RCA off, or within the cooldown)", () => {
    expect(plan([sig()]).items[0]).toMatchObject({ kind: "new", rca: null });
  });

  it("waits for an earlier opening's RCA when a reopening in the cooldown has none", () => {
    const s = sig({ reopenSeq: 2, notifiedReopenSeq: 0, notifiedHitCount: 3, hitCount: 5 });
    const running: [string, Omit<OpeningRca, "reopenSeq">] = [
      "s1:1",
      { status: "running", result: null, createTime: new Date(T0 - MIN) },
    ];
    expect(plan([s], [running]).items).toEqual([]);
    const done: [string, Omit<OpeningRca, "reopenSeq">] = [
      "s1:1",
      { status: "done", result: "- Root cause: late", createTime: new Date(T0 - MIN) },
    ];
    expect(plan([s], [done]).items[0]).toMatchObject({
      kind: "reopened",
      rca: { state: "done", rootCause: "late" },
    });
    // An RCA from an opening already announced is not this announcement's.
    const old: [string, Omit<OpeningRca, "reopenSeq">] = [
      "s1:0",
      { status: "running", result: null, createTime: new Date(T0 - MIN) },
    ];
    expect(plan([s], [old]).items[0]).toMatchObject({ kind: "reopened", rca: null });
  });

  it("labels a reopening, and reports a failed RCA", () => {
    const p = plan(
      [sig({ reopenSeq: 2, notifiedReopenSeq: 1, notifiedHitCount: 3, hitCount: 4 })],
      [["s1:2", { status: "failed", result: "RCA failed: x", createTime: new Date(T0) }]],
    );
    expect(p.items[0]).toMatchObject({ kind: "reopened", newHits: 1, rca: { state: "failed" } });
  });

  it("adds ongoing signals to an announcement", () => {
    const p = plan([
      sig(),
      sig({ id: "s2", notifiedReopenSeq: 0, notifiedHitCount: 10, hitCount: 14 }),
    ]);
    expect(p.items.map((i) => [i.signalId, i.kind, i.newHits])).toEqual([
      ["s1", "new", 3],
      ["s2", "ongoing", 4],
    ]);
  });

  it("sends ongoing signals alone at most hourly, and never while an announcement waits", () => {
    const ongoing = sig({ notifiedReopenSeq: 0, notifiedHitCount: 1, hitCount: 5 });
    expect(plan([ongoing], [], T0 - 30 * MIN).items).toEqual([]);
    expect(plan([ongoing], [], T0 - 61 * MIN).items).toHaveLength(1);
    expect(plan([ongoing], [], null).items).toHaveLength(1);
    const waiting = sig({ id: "s2" });
    const held = plan(
      [ongoing, waiting],
      [["s2:0", { status: "running", result: null, createTime: new Date(T0 - MIN) }]],
      null,
    );
    expect(held.items).toEqual([]);
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
    const p = plan([sig({ notifiedReopenSeq: 0, notifiedHitCount: 5, hitCount: 4 })], [], null);
    expect(p.items).toEqual([]);
    expect(p.consumed).toEqual([{ id: "s1", reopenSeq: 0, hitCount: 4, sent: false }]);
  });
});

function fakeDb(signals: PendingSignal[], lastSentAt: Date | null = null) {
  const updates: unknown[] = [];
  const raws: { sql: string; values: unknown[] }[] = [];
  const queries: string[] = [];
  const db = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      queries.push(sql);
      if (sql.includes("max(notified_at)")) return [{ lastSentAt }];
      if (sql.includes("SELECT DISTINCT project_id"))
        return [{ projectId: "p1" }, { projectId: "p2" }];
      return signals;
    }),
    $executeRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const op = { sql: strings.join("?"), values };
      raws.push(op);
      return op;
    }),
    $transaction: vi.fn(async (ops: unknown[]) => ops),
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
          createTime: new Date(T0 - MIN),
          rca: { status: "done", result: "- Root cause: swallowed" },
        },
      ]),
    },
    signal: { update: vi.fn((args: unknown) => (updates.push(args), args)) },
  };
  return { db, updates, raws, queries };
}

describe("loadDigestInput", () => {
  it("reads unreported signals, grouping detectors, RCAs and the last send", async () => {
    const { db, queries } = fakeDb(
      [sig(), sig({ id: "s2", detectorId: "d2" })],
      new Date(T0 - MIN),
    );
    const input = await loadDigestInput(db as never, "p1", T0);
    expect(queries[0]).toContain("notified_reopen_seq IS DISTINCT FROM reopen_seq");
    expect([...input.groupingDetectors]).toEqual([["d1", "Failure"]]);
    expect(input.rcas.get("s1")).toEqual([
      expect.objectContaining({ reopenSeq: 0, status: "done" }),
    ]);
    expect(input.lastSentAt).toBe(T0 - MIN);
  });

  it("treats every detector as not grouping without the signals key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { db } = fakeDb([sig()]);
    expect((await loadDigestInput(db as never, "p1", T0)).groupingDetectors.size).toBe(0);
  });
});

describe("recordDigest", () => {
  it("records the values read, and the send time only for sent signals", async () => {
    const { db, updates, raws } = fakeDb([]);
    await recordDigest(
      db as never,
      {
        items: [],
        consumed: [
          { id: "a", reopenSeq: 1, hitCount: 7, sent: true },
          { id: "b", reopenSeq: 0, hitCount: 2, sent: false },
        ],
      },
      new Date(T0),
    );
    expect(updates).toEqual([
      {
        where: { id: "a" },
        data: { notifiedReopenSeq: 1, notifiedHitCount: 7, notifiedAt: new Date(T0) },
      },
      { where: { id: "b" }, data: { notifiedReopenSeq: 0, notifiedHitCount: 2 } },
    ]);
    // Then, in the same transaction, a count above a hit count lowered by a
    // concurrent move is cut to it.
    expect(raws).toEqual([
      { sql: expect.stringContaining("SET notified_hit_count = hit_count"), values: [["a", "b"]] },
    ]);
    expect(raws[0].sql).toContain("notified_hit_count > hit_count");
    expect(db.$transaction).toHaveBeenCalledWith([updates[0], updates[1], raws[0]]);
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
  it("enqueues one digest job per project, a minute out by default", async () => {
    await enqueueSignalDigest("p1");
    expect(mockAdd).toHaveBeenCalledWith(
      "signal-digest-p1",
      { kind: "signals", projectId: "p1" },
      expect.objectContaining({ jobId: "signal-digest-p1", delay: 60_000, removeOnComplete: true }),
    );
  });

  it("sweeps projects whose changes waited over five minutes", async () => {
    const { db, queries } = fakeDb([]);
    expect(await sweepSignalDigests(db as never, T0)).toBe(2);
    expect(queries[0]).toContain("update_time <");
    expect(mockAdd.mock.calls.map((c) => [c[1].projectId, c[2].delay])).toEqual([
      ["p1", 0],
      ["p2", 0],
    ]);
  });
});
