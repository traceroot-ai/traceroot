import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AlertRenotify } from "@traceroot/core";
import type { AlertRowLike } from "../rule.js";
import type { AlertRuntimeState } from "../state-machine.js";
import type { AlertTick } from "../tick.js";

const findMany = vi.fn<(args: Record<string, unknown>) => Promise<AlertRowLike[]>>();
const updateMany = vi.fn<(args: Record<string, unknown>) => Promise<{ count: number }>>();

vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  return {
    ...actual,
    prisma: { alert: { findMany, updateMany } },
  };
});

const {
  claimDueAlerts,
  completeAlertEvaluation,
  recordAlertEvaluationFailure,
  recordAlertNotifyOutcome,
  revertAlertEmissionState,
  ALERT_CLAIM_LIMIT,
  ALERT_CLAIM_SCAN_LIMIT,
} = await import("../claim.js");
// Real, not faked: whether a page survives the race below is a question about
// what the state machine does next with the row the writes leave behind.
const { applyAlertStateMachine } = await import("../state-machine.js");

const NOW = new Date("2026-08-12T10:37:42.913Z");

const TICK: AlertTick = {
  now: NOW,
  boundary: new Date("2026-08-12T10:37:00.000Z"),
  windowEnd: new Date("2026-08-12T10:36:30.000Z"),
};

/** `row()`'s own window is 10m, so it re-arms at the cadence cap, not at the tick. */
const CAPPED_NEXT_RUN = new Date("2026-08-12T10:42:00.000Z");

/** What a window this build cannot read falls back to: one tick, as before. */
const TICK_NEXT_RUN = new Date("2026-08-12T10:38:00.000Z");

function row(overrides: Partial<AlertRowLike> = {}): AlertRowLike {
  return {
    id: "alert-1",
    projectId: "proj-1",
    name: "P95 latency",
    view: "SPANS",
    measure: "latency",
    aggregation: "p95",
    filters: [{ field: "service_name", op: "=", value: "api" }],
    window: "10m",
    thresholdOperator: ">",
    threshold: 500,
    renotify: { mode: "OFF" },
    noDataMode: "HOLD",
    severity: "OK",
    severityChangedAt: null,
    alertedAt: null,
    ...overrides,
  };
}

const rowsFor = (projectId: string, count: number): AlertRowLike[] =>
  Array.from({ length: count }, (_, index) => row({ id: `${projectId}-${index}`, projectId }));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  findMany.mockReset().mockResolvedValue([]);
  updateMany.mockReset().mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("claimDueAlerts — the read that selects candidates", () => {
  it("takes only ACTIVE, due rules whose project is still live", async () => {
    await claimDueAlerts(TICK);

    const [args] = findMany.mock.calls[0];
    const where = args.where as Record<string, unknown>;
    expect(where).toMatchObject({ project: { deleteTime: null }, status: "ACTIVE" });
    expect(where.OR).toEqual([{ nextRunAt: null }, { nextRunAt: { lte: NOW } }]);
    expect(args.take).toBe(ALERT_CLAIM_SCAN_LIMIT);
    expect(ALERT_CLAIM_SCAN_LIMIT).toBeGreaterThan(ALERT_CLAIM_LIMIT);
    // `nulls: "first"` put every rule created since the last tick ahead of every
    // rule that was actually due, so a burst of new rules preempted the schedule.
    expect(args.orderBy).toEqual([{ nextRunAt: "asc" }, { createTime: "asc" }]);
  });

  it("claims no more than the budget, and never all of it for one project", async () => {
    findMany.mockResolvedValue([
      ...rowsFor("proj-noisy", ALERT_CLAIM_SCAN_LIMIT - 100),
      ...rowsFor("proj-quiet", 100),
    ]);

    const claims = await claimDueAlerts(TICK);
    const byProject = claims.reduce<Record<string, number>>((counts, claim) => {
      const key = claim.rule.projectId;
      return { ...counts, [key]: (counts[key] ?? 0) + 1 };
    }, {});

    expect(claims).toHaveLength(ALERT_CLAIM_LIMIT);
    expect(updateMany).toHaveBeenCalledTimes(ALERT_CLAIM_LIMIT);
    // Round-robin: the quiet project's whole backlog rides along rather than
    // waiting behind a project that could fill the budget on its own.
    expect(byProject["proj-quiet"]).toBe(100);
    expect(byProject["proj-noisy"]).toBe(ALERT_CLAIM_LIMIT - 100);
    // Sharing the budget must not reshuffle the scan's oldest-due-first order.
    expect(claims[0].rule.id).toBe("proj-noisy-0");
  });

  it("never sees a project whose due rules all sort past the scan cap", async () => {
    // The scan is one globally-ordered read, so the budget can only be shared
    // among projects inside the slice it returns.
    const due = [...rowsFor("proj-noisy", ALERT_CLAIM_SCAN_LIMIT), ...rowsFor("proj-quiet", 100)];
    findMany.mockImplementation(async (args) => due.slice(0, args.take as number));

    const claims = await claimDueAlerts(TICK);

    expect(claims).toHaveLength(ALERT_CLAIM_LIMIT);
    // The budget had room for the quiet project; the scan never showed it.
    expect(claims.every((claim) => claim.rule.projectId === "proj-noisy")).toBe(true);
  });
});

describe("claimDueAlerts — taking ownership", () => {
  it("stamps the claim and advances nextRunAt under a CAS on lastClaimedAt", async () => {
    const previousClaim = new Date("2026-08-12T10:36:00.000Z");
    findMany.mockResolvedValue([{ ...row(), lastClaimedAt: previousClaim } as AlertRowLike]);

    const claims = await claimDueAlerts(TICK);

    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: "alert-1", lastClaimedAt: previousClaim },
      data: { lastClaimedAt: TICK.now, nextRunAt: CAPPED_NEXT_RUN },
    });
    expect(claims).toHaveLength(1);
    expect(claims[0].claimStamp).toBe(TICK.now);
    expect(claims[0].rule.id).toBe("alert-1");
  });

  it("drops a row whose CAS another scheduler won", async () => {
    findMany.mockResolvedValue([row()]);
    updateMany.mockResolvedValue({ count: 0 });

    expect(await claimDueAlerts(TICK)).toEqual([]);
  });

  it("claims an unparseable row before discarding it, so it stops being due", async () => {
    findMany.mockResolvedValue([row({ window: "24h" })]);

    expect(await claimDueAlerts(TICK)).toEqual([]);
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "alert-1" },
      // No window to derive a cadence from, so it keeps the tick's.
      data: { lastClaimedAt: TICK.now, nextRunAt: TICK_NEXT_RUN },
    });
  });

  it("re-arms each row on its own window rather than on one cadence for the tick", async () => {
    findMany.mockResolvedValue([
      row({ id: "narrow", window: "1m" }),
      row({ id: "wide", window: "2h" }),
    ]);

    await claimDueAlerts(TICK);

    const scheduled = new Map(
      updateMany.mock.calls.map(([args]) => {
        const { where, data } = args as {
          where: { id: string };
          data: { nextRunAt: Date };
        };
        return [where.id, data.nextRunAt.toISOString()];
      }),
    );
    // The 1m rule is unchanged; the 2h rule skips the next four ticks entirely.
    expect(scheduled.get("narrow")).toBe(TICK_NEXT_RUN.toISOString());
    expect(scheduled.get("wide")).toBe(CAPPED_NEXT_RUN.toISOString());
  });

  it("leaves the reason on a row it will never be able to evaluate", async () => {
    // `nextRunAt` still advances, so without this the row is re-read and
    // re-written every minute while the owner reads a severity that is frozen,
    // an empty error column, and no sign the rule will never fire again.
    findMany.mockResolvedValue([row({ window: "24h" })]);

    await claimDueAlerts(TICK);

    const failure = updateMany.mock.calls[1][0] as { where: unknown; data: Record<string, string> };
    expect(failure.where).toEqual({ id: "alert-1", status: "ACTIVE", lastClaimedAt: TICK.now });
    expect(failure.data.lastError).toContain("cannot be evaluated");
    expect(failure.data.lastErrorAt).toBeInstanceOf(Date);
    // Still not a claim: the row is dropped from this tick either way.
    expect(await claimDueAlerts(TICK)).toEqual([]);
  });

  it("keeps an unwritable reason to itself rather than losing the rest of the batch", async () => {
    findMany.mockResolvedValue([row({ window: "24h" }), row({ id: "alert-2" })]);
    updateMany.mockImplementation(async (args) => {
      const data = args.data as Record<string, unknown>;
      if ("lastError" in data) throw new Error("pool timeout");
      return { count: 1 };
    });

    expect((await claimDueAlerts(TICK)).map((claim) => claim.rule.id)).toEqual(["alert-2"]);
  });
});

describe("completeAlertEvaluation", () => {
  it("writes both clocks under a CAS on the claim stamp, ACTIVE, and the state it decided from", async () => {
    const written = await completeAlertEvaluation({
      alertId: "alert-1",
      claimStamp: NOW,
      previousAlertedAt: null,
      state: { severity: "ALERT", severityChangedAt: TICK.boundary, alertedAt: TICK.boundary },
      evaluatedAt: TICK.boundary,
    });

    expect(written).toBe(true);
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: "alert-1", status: "ACTIVE", lastClaimedAt: NOW, alertedAt: null },
      data: {
        severity: "ALERT",
        severityChangedAt: TICK.boundary,
        alertedAt: TICK.boundary,
        lastEvaluatedAt: TICK.boundary,
        lastError: null,
        lastErrorAt: null,
      },
    });
  });

  it("records the reason the completion carries, truncated to the cell it is read in", async () => {
    const failedAt = new Date("2026-08-12T10:37:05.000Z");
    const state = { severity: "OK" as const, severityChangedAt: null, alertedAt: null };

    await completeAlertEvaluation({
      alertId: "alert-1",
      claimStamp: NOW,
      previousAlertedAt: null,
      state,
      evaluatedAt: TICK.boundary,
      error: { message: "notification not delivered (no-channel)", at: failedAt },
    });
    await completeAlertEvaluation({
      alertId: "alert-1",
      claimStamp: NOW,
      previousAlertedAt: null,
      state,
      evaluatedAt: TICK.boundary,
      error: { message: "x".repeat(900), at: NOW },
    });

    const dataOf = (index: number) =>
      (updateMany.mock.calls[index][0] as { data: Record<string, unknown> }).data;
    expect(dataOf(0).lastError).toBe("notification not delivered (no-channel)");
    expect(dataOf(0).lastErrorAt).toBe(failedAt);
    expect(dataOf(1).lastError as string).toHaveLength(500);
    expect(dataOf(1).lastError as string).toMatch(/\.\.\.$/);
  });

  it("reports false when the CAS matched no row", async () => {
    updateMany.mockResolvedValue({ count: 0 });

    expect(
      await completeAlertEvaluation({
        alertId: "alert-1",
        claimStamp: NOW,
        previousAlertedAt: null,
        state: { severity: "OK", severityChangedAt: null, alertedAt: null },
        evaluatedAt: TICK.boundary,
      }),
    ).toBe(false);
  });
});

describe("recordAlertEvaluationFailure", () => {
  const failedAt = new Date("2026-08-12T10:37:09.000Z");

  it("writes the reason under the same CAS, leaving lastEvaluatedAt to mean the last good run", async () => {
    await recordAlertEvaluationFailure({
      alertId: "alert-1",
      claimStamp: NOW,
      error: { message: "the evaluator returned no result for this rule", at: failedAt },
    });

    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: "alert-1", status: "ACTIVE", lastClaimedAt: NOW },
      data: {
        lastError: "the evaluator returned no result for this rule",
        lastErrorAt: failedAt,
      },
    });
  });

  it("reports false when a later tick has already re-claimed the rule", async () => {
    updateMany.mockResolvedValue({ count: 0 });

    expect(
      await recordAlertEvaluationFailure({
        alertId: "alert-1",
        claimStamp: NOW,
        error: { message: "boom", at: failedAt },
      }),
    ).toBe(false);
  });
});

describe("revertAlertEmissionState", () => {
  const EMITTED_AT = TICK.boundary;
  const REVERTED_AT = new Date("2026-08-12T11:07:00.000Z");
  const PRIOR_STATE = {
    severity: "OK" as const,
    severityChangedAt: new Date("2026-08-12T09:00:00.000Z"),
    alertedAt: null,
  };

  const revertOf = () => ({
    alertId: "alert-1",
    emittedSeverity: "ALERT" as const,
    emittedAt: EMITTED_AT,
    priorState: PRIOR_STATE,
    error: { message: "notification not delivered (no-channel)", at: REVERTED_AT },
  });

  /**
   * The row as the emission left it, half an hour before the delivery gave up.
   * `lastClaimedAt` has moved on because every tick since re-claimed the rule.
   */
  const emittedRow = (overrides: Record<string, unknown> = {}) => ({
    id: "alert-1",
    status: "ACTIVE",
    severity: "ALERT",
    alertedAt: EMITTED_AT,
    lastClaimedAt: new Date("2026-08-12T11:06:00.000Z"),
    ...overrides,
  });

  /** Matches the way the row would, so a refusal is the predicate's doing. */
  const rowUnderTest = (stored: Record<string, unknown>): void => {
    updateMany.mockImplementation(async (args) => {
      const where = args.where as Record<string, unknown>;
      const matches = Object.entries(where).every(([field, expected]) => {
        const actual = stored[field];
        return expected instanceof Date && actual instanceof Date
          ? expected.getTime() === actual.getTime()
          : expected === actual;
      });
      return { count: matches ? 1 : 0 };
    });
  };

  it("undoes the emission on a rule every tick since has re-claimed", async () => {
    rowUnderTest(emittedRow());

    expect(await revertAlertEmissionState(revertOf())).toBe(true);
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: "alert-1", status: "ACTIVE", severity: "ALERT", alertedAt: EMITTED_AT },
      data: {
        severity: "OK",
        severityChangedAt: PRIOR_STATE.severityChangedAt,
        alertedAt: null,
        lastError: "notification not delivered (no-channel)",
        lastErrorAt: REVERTED_AT,
      },
    });
  });

  it("leaves lastEvaluatedAt where the ticks since put it", async () => {
    // Those evaluations really happened; only the emission is being taken back.
    rowUnderTest(emittedRow());
    await revertAlertEmissionState(revertOf());

    const { data } = updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data).not.toHaveProperty("lastEvaluatedAt");
  });

  it("refuses a rule whose severity has moved since the emission", async () => {
    // The breach resolved on its own, so there is nothing left to re-announce.
    rowUnderTest(emittedRow({ severity: "OK", alertedAt: EMITTED_AT }));

    expect(await revertAlertEmissionState(revertOf())).toBe(false);
  });

  it("refuses a rule a later emission has already re-stamped", async () => {
    // Rewinding here would move the renotify clock back behind a page that was
    // delivered.
    rowUnderTest(emittedRow({ alertedAt: new Date("2026-08-12T11:00:00.000Z") }));

    expect(await revertAlertEmissionState(revertOf())).toBe(false);
  });

  it("refuses a rule that is no longer ACTIVE", async () => {
    rowUnderTest(emittedRow({ status: "PAUSED" }));

    expect(await revertAlertEmissionState(revertOf())).toBe(false);
  });
});

describe("a compensation that lands while the tick it raced is still at the evaluator", () => {
  const EMITTED_AT = new Date("2026-08-12T11:50:00.000Z");
  const BOUNDARY = new Date("2026-08-12T12:00:00.000Z");
  const CLAIM = new Date("2026-08-12T12:00:00.400Z");
  const GAVE_UP_AT = new Date("2026-08-12T12:00:05.000Z");
  const CHANGED_AT = new Date("2026-08-12T09:00:00.000Z");
  const OFF: AlertRenotify = { mode: "OFF" };
  const EVERY_10: AlertRenotify = { mode: "EVERY", intervalMinutes: 10 };

  /** One row that answers a CAS the way the database would and then takes the write. */
  function rowStore(initial: Record<string, unknown>) {
    const store = { row: initial };
    updateMany.mockImplementation(async (args) => {
      const current = store.row;
      const matches = Object.entries(args.where as Record<string, unknown>).every(
        ([field, expected]) => {
          const actual = current[field];
          return expected instanceof Date && actual instanceof Date
            ? expected.getTime() === actual.getTime()
            : expected === actual;
        },
      );
      if (!matches) return { count: 0 };
      store.row = { ...current, ...(args.data as Record<string, unknown>) };
      return { count: 1 };
    });
    return store;
  }

  /** The row as the 11:50 emission left it, re-claimed by the 12:00 tick. */
  const emittedRow = () => ({
    id: "alert-1",
    status: "ACTIVE",
    severity: "ALERT",
    severityChangedAt: EMITTED_AT,
    alertedAt: EMITTED_AT,
    lastClaimedAt: CLAIM,
  });

  const stateOf = (row: Record<string, unknown>): AlertRuntimeState => ({
    severity: row.severity as AlertRuntimeState["severity"],
    severityChangedAt: row.severityChangedAt as Date | null,
    alertedAt: row.alertedAt as Date | null,
  });

  /** 12:00:05, after half an hour of retries: the page provably never arrived. */
  const giveThePageBack = async (): Promise<boolean> =>
    await revertAlertEmissionState({
      alertId: "alert-1",
      emittedSeverity: "ALERT",
      emittedAt: EMITTED_AT,
      priorState: { severity: "OK", severityChangedAt: CHANGED_AT, alertedAt: null },
      error: { message: "notification not delivered (retries-exhausted)", at: GAVE_UP_AT },
    });

  it("survives the completion of that tick, and the breach is announced afresh", async () => {
    const store = rowStore(emittedRow());
    // 12:00 read (ALERT, 11:50) and sent the batch to the evaluator.
    const previous = stateOf(store.row);

    expect(await giveThePageBack()).toBe(true);
    expect(store.row).toMatchObject({ severity: "OK", alertedAt: null });

    // 12:00:20, the evaluator answers: still breaching, and against the state
    // this tick read, an outstanding page means there is nothing to say.
    const transition = applyAlertStateMachine(previous, "ALERT", BOUNDARY, OFF);
    expect(transition.emit).toBe(false);
    const written = await completeAlertEvaluation({
      alertId: "alert-1",
      claimStamp: CLAIM,
      previousAlertedAt: previous.alertedAt,
      state: transition.nextState,
      evaluatedAt: BOUNDARY,
    });

    // A compensation never moves the claim token, so this is the only thing
    // between the rollback and being written straight back over.
    expect(written).toBe(false);
    expect(store.row).toMatchObject({ severity: "OK", alertedAt: null });
    // Which is the point of the rollback: the next tick has a breach to raise.
    expect(
      applyAlertStateMachine(stateOf(store.row), "ALERT", new Date("2026-08-12T12:01:00.000Z"), OFF)
        .emit,
    ).toBe(true);
  });

  it.each([
    // An all-clear for a page the rollback said nobody ever received.
    ["a recovery reached the evaluator first", "OK" as const, OFF],
    // A renotify re-pinning the very state the rollback retracted.
    ["a renotify came due in the same window", "ALERT" as const, EVERY_10],
  ])("takes no write when %s", async (_label, severity, renotify) => {
    const store = rowStore(emittedRow());
    const previous = stateOf(store.row);

    await giveThePageBack();

    const transition = applyAlertStateMachine(previous, severity, BOUNDARY, renotify);
    expect(transition.emit).toBe(true);
    const written = await completeAlertEvaluation({
      alertId: "alert-1",
      claimStamp: CLAIM,
      previousAlertedAt: previous.alertedAt,
      state: transition.nextState,
      evaluatedAt: BOUNDARY,
    });

    // False also stops the scheduler enqueueing, which is what keeps the
    // message itself from going out on a decision the row no longer supports.
    expect(written).toBe(false);
    expect(store.row).toMatchObject({ severity: "OK", alertedAt: null });
  });

  it("still writes when nothing raced it", async () => {
    const store = rowStore(emittedRow());
    const previous = stateOf(store.row);
    const transition = applyAlertStateMachine(previous, "OK", BOUNDARY, OFF);

    const written = await completeAlertEvaluation({
      alertId: "alert-1",
      claimStamp: CLAIM,
      previousAlertedAt: previous.alertedAt,
      state: transition.nextState,
      evaluatedAt: BOUNDARY,
    });

    expect(written).toBe(true);
    expect(store.row).toMatchObject({ severity: "OK", alertedAt: BOUNDARY });
  });
});

describe("recordAlertNotifyOutcome", () => {
  const at = new Date("2026-08-12T10:40:00.000Z");

  it("records a delivery against the rule alone, with no claim to match on", async () => {
    await recordAlertNotifyOutcome({ alertId: "alert-1", status: "DELIVERED", error: null, at });

    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: "alert-1" },
      data: { lastNotifyStatus: "DELIVERED", lastNotifyError: null, lastNotifyAt: at },
    });
  });

  it("holds a superseded job's outcome behind anything recorded since its emission", async () => {
    // These settle out of order: a recovery still retrying at 12:20 reports on
    // the 12:05 emission, long after the 12:10 page delivered. Overwriting that
    // would leave a delivered page reading as undelivered.
    const emittedAt = new Date("2026-08-12T10:05:00.000Z");
    await recordAlertNotifyOutcome({
      alertId: "alert-1",
      status: "SUPERSEDED",
      error: "superseded",
      at,
      notAfter: emittedAt,
    });

    expect(updateMany.mock.calls[0][0]).toEqual({
      where: {
        id: "alert-1",
        OR: [{ lastNotifyAt: null }, { lastNotifyAt: { lt: emittedAt } }],
      },
      data: { lastNotifyStatus: "SUPERSEDED", lastNotifyError: "superseded", lastNotifyAt: at },
    });
  });

  it("swallows its own write failure, so a sent page is never sent twice", async () => {
    updateMany.mockRejectedValue(new Error("pool timeout"));

    await expect(
      recordAlertNotifyOutcome({ alertId: "alert-1", status: "DELIVERED", error: null, at }),
    ).resolves.toBeUndefined();
  });
});
