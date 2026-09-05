import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AlertFilter } from "@traceroot/core";
import type {
  AlertCompletion,
  AlertEmissionRevert,
  AlertFailureRecord,
  ClaimedAlert,
} from "../claim.js";
import type { AlertRule } from "../rule.js";
import type { AlertEvaluationRequest, AlertEvaluationResult } from "../evaluator-client.js";
import type { AlertNotification } from "../../queues/alert-notification-queue.js";

const evaluateAlerts =
  vi.fn<(request: AlertEvaluationRequest) => Promise<AlertEvaluationResult[]>>();
const claimDueAlerts = vi.fn<() => Promise<ClaimedAlert[]>>();
const completeAlertEvaluation = vi.fn<(completion: AlertCompletion) => Promise<boolean>>();
const recordAlertEvaluationFailure = vi.fn<(failure: AlertFailureRecord) => Promise<boolean>>();
const parkAlertRule = vi.fn<(failure: AlertFailureRecord) => Promise<boolean>>();
const revertAlertEmissionState = vi.fn<(revert: AlertEmissionRevert) => Promise<boolean>>();
const enqueueAlertNotification = vi.fn<(payload: AlertNotification) => Promise<void>>();

// Only the wire call is faked: `isSendableAlertSpec` and the chunk size stay
// real, so the partition under test is the one the scheduler actually applies.
vi.mock("../evaluator-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../evaluator-client.js")>();
  return { ...actual, evaluateAlerts };
});

// Everything the scheduler reaches indirectly belongs here too, including `revertAlertEmissionState`.
vi.mock("../claim.js", () => ({
  claimDueAlerts,
  completeAlertEvaluation,
  parkAlertRule,
  recordAlertEvaluationFailure,
  revertAlertEmissionState,
}));

vi.mock("../../notifications/alert-slack.js", () => ({ enqueueAlertNotification }));

type CronHandler = () => Promise<void> | void;
const cronSchedule = vi.fn((expression: string, handler: CronHandler) => ({
  expression,
  handler,
  stop: vi.fn(),
}));
vi.mock("node-cron", () => ({
  default: {
    schedule: (expression: string, handler: CronHandler) => cronSchedule(expression, handler),
  },
}));

const { chunk, isAlertsSchedulerEnabled, runAlertTick, startAlertScheduler } =
  await import("../scheduler.js");
const { ALERT_EVALUATION_CHUNK_SIZE, ALERT_EVALUATION_CONCURRENCY } =
  await import("../evaluator-client.js");

const NOW = new Date("2026-08-12T10:37:42.913Z");
const BOUNDARY = new Date("2026-08-12T10:37:00.000Z");
const WINDOW_END = new Date("2026-08-12T10:36:30.000Z");
const WINDOW_START_10M = new Date("2026-08-12T10:26:30.000Z");

const claimWith = (id: string, overrides: Partial<AlertRule> = {}): ClaimedAlert => ({
  rule: {
    id,
    projectId: "proj-1",
    name: `Alert ${id}`,
    view: "SPANS",
    measure: "latency",
    aggregation: "avg",
    filters: [],
    window: "10m",
    thresholdOperator: ">",
    threshold: 100,
    renotify: { mode: "OFF" },
    noDataMode: "HOLD",
    state: { severity: "OK", severityChangedAt: null, alertedAt: null },
    ...overrides,
  },
  claimStamp: NOW,
});

const claimFiltered = (id: string, filters: AlertFilter[]): ClaimedAlert =>
  claimWith(id, { filters });

const okResult = (alertId: string): AlertEvaluationResult => ({
  alert_id: alertId,
  value: 5,
  row_count: 3,
  error: null,
  errorKind: null,
});

const breachResult = (alertId: string, value = 250): AlertEvaluationResult => ({
  alert_id: alertId,
  value,
  row_count: 12,
  error: null,
  errorKind: null,
});

const yieldToLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  cronSchedule.mockClear();
  evaluateAlerts.mockReset().mockResolvedValue([]);
  claimDueAlerts.mockReset().mockResolvedValue([]);
  completeAlertEvaluation.mockReset().mockResolvedValue(true);
  recordAlertEvaluationFailure.mockReset().mockResolvedValue(true);
  parkAlertRule.mockReset().mockResolvedValue(true);
  revertAlertEmissionState.mockReset().mockResolvedValue(true);
  enqueueAlertNotification.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chunk", () => {
  it("splits into runs of the requested size, in order, with a short final run", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2], 25)).toEqual([[1, 2]]);
    expect(chunk([], 25)).toEqual([]);
    // Rather than looping forever on a size below one.
    expect(chunk([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
  });
});

describe("isAlertsSchedulerEnabled", () => {
  it("runs by default and reads both spellings of on and off, in any casing", () => {
    for (const on of [undefined, "", "   ", "true", "TRUE", " true ", "1", "yes", "on", " On "]) {
      expect(isAlertsSchedulerEnabled(on)).toBe(true);
    }
    // An operator reaches for one of these mid-incident.
    for (const off of ["false", " FALSE ", "0", "no", "off", " Off "]) {
      expect(isAlertsSchedulerEnabled(off)).toBe(false);
    }
    expect(console.error).not.toHaveBeenCalled();
  });

  it("warns and turns alerting off on a spelling it cannot read", () => {
    // Setting this at all is deliberate, and the reason to reach for it
    // mid-incident is to stop the paging, so an unreadable value fails closed.
    // It stays a log rather than a throw because throwing took the detector run,
    // RCA and digest workers down with it: they share this boot path.
    for (const value of ["enabled", "True!", "disable", "nope"]) {
      expect(() => isAlertsSchedulerEnabled(value)).not.toThrow();
      expect(isAlertsSchedulerEnabled(value)).toBe(false);
    }

    const warning = (console.error as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(warning).toContain('"true"/"1"/"yes"/"on"');
    expect(warning).toContain('"false"/"0"/"no"/"off"');
    expect(warning).toContain("alerting is off");
  });
});

describe("runAlertTick — an unsendable spec is that alert's own failure", () => {
  it("never sends a rejected spec, and leaves its window group's siblings alone", async () => {
    // Grouping is by project and window, so a rejected rule must not remove its
    // group's siblings from the request their window depends on.
    claimDueAlerts.mockResolvedValue([
      claimFiltered("bad-op", [{ field: "status", op: "any of", value: "error" }]),
      claimFiltered("long", [{ field: "status", op: "=", value: "error" }]),
      claimWith("short", { filters: [{ field: "status", op: "=", value: "error" }], window: "1m" }),
    ]);
    evaluateAlerts.mockImplementation(async (request) =>
      request.alerts.map((spec) => okResult(spec.alert_id)),
    );

    await runAlertTick(NOW);

    const requested = evaluateAlerts.mock.calls.map(([request]) =>
      request.alerts.map((spec) => spec.alert_id),
    );
    expect(requested.sort()).toEqual([["long"], ["short"]]);
    expect(completeAlertEvaluation.mock.calls.map(([c]) => c.alertId).sort()).toEqual([
      "long",
      "short",
    ]);
    expect(enqueueAlertNotification).not.toHaveBeenCalled();

    // The reason lands on the rejected rule alone, under this tick's claim stamp.
    // It is a park, not a retry: the backend would refuse this spec every minute.
    expect(recordAlertEvaluationFailure).not.toHaveBeenCalled();
    expect(parkAlertRule).toHaveBeenCalledTimes(1);
    const [parked] = parkAlertRule.mock.calls[0];
    expect(parked.alertId).toBe("bad-op");
    expect(parked.claimStamp).toBe(NOW);
    expect(parked.error.message).toContain("filter the evaluator does not accept");
    expect(parked.error.message).toContain("parked");
    expect(parked.error.at).toBeInstanceOf(Date);
  });
});

describe("runAlertTick — a rejection of the rule rather than of the run", () => {
  const failedResult = (
    alertId: string,
    error: string,
    errorKind: AlertEvaluationResult["errorKind"],
  ): AlertEvaluationResult => ({ alert_id: alertId, value: null, row_count: 0, error, errorKind });

  it("parks the rule the evaluator refused on its spec, and retries the one whose run failed", async () => {
    claimDueAlerts.mockResolvedValue([claimWith("bad-measure"), claimWith("flaky")]);
    evaluateAlerts.mockResolvedValue([
      failedResult("bad-measure", "measure: Unknown alert measure 'clicks'", "spec"),
      failedResult("flaky", "Query execution failed", "query"),
    ]);

    await runAlertTick(NOW);

    expect(parkAlertRule.mock.calls.map(([f]) => f.alertId)).toEqual(["bad-measure"]);
    expect(parkAlertRule.mock.calls[0][0].error.message).toContain("Unknown alert measure");
    expect(recordAlertEvaluationFailure.mock.calls.map(([f]) => f.alertId)).toEqual(["flaky"]);
    expect(completeAlertEvaluation).not.toHaveBeenCalled();
  });

  it("retries a failure a backend too old to classify it left unlabelled", async () => {
    // The field is absent on the wire, so the rule keeps running rather than
    // being stopped on a guess about what the message means.
    claimDueAlerts.mockResolvedValue([claimWith("a")]);
    evaluateAlerts.mockResolvedValue([failedResult("a", "measure: Unknown alert measure", null)]);

    await runAlertTick(NOW);

    expect(parkAlertRule).not.toHaveBeenCalled();
    expect(recordAlertEvaluationFailure.mock.calls.map(([f]) => f.alertId)).toEqual(["a"]);
  });

  it("keeps the rule running when the park write itself fails", async () => {
    // A park that did not land must not read as a stopped rule: the reason is
    // recorded instead and the next tick tries again.
    claimDueAlerts.mockResolvedValue([claimWith("a")]);
    evaluateAlerts.mockResolvedValue([failedResult("a", "view: Unsupported alert view", "spec")]);
    parkAlertRule.mockRejectedValue(new Error("pool timeout"));

    await expect(runAlertTick(NOW)).resolves.toBeUndefined();

    expect(recordAlertEvaluationFailure.mock.calls[0][0].error.message).toContain(
      "Unsupported alert view",
    );
  });
});

describe("runAlertTick — the page a transition produces", () => {
  it("pages on the entry into ALERT, carrying the severity it came from", async () => {
    const changedAt = new Date("2026-08-12T09:00:00.000Z");
    claimDueAlerts.mockResolvedValue([
      claimWith("hot-1", {
        state: { severity: "OK", severityChangedAt: changedAt, alertedAt: null },
      }),
    ]);
    evaluateAlerts.mockResolvedValue([breachResult("hot-1", 250)]);

    await runAlertTick(NOW);

    // The transition's clocks are written before anything is enqueued.
    const [completion] = completeAlertEvaluation.mock.calls[0];
    expect(completion.alertId).toBe("hot-1");
    expect(completion.claimStamp).toBe(NOW);
    expect(completion.evaluatedAt.getTime()).toBe(BOUNDARY.getTime());
    expect(completion.state).toEqual({
      severity: "ALERT",
      severityChangedAt: BOUNDARY,
      alertedAt: BOUNDARY,
    });
    expect(completion.previousAlertedAt).toBeNull();

    expect(enqueueAlertNotification).toHaveBeenCalledTimes(1);
    const [payload] = enqueueAlertNotification.mock.calls[0];
    expect(payload.severity).toBe("ALERT");
    // The severity the rule held before this evaluation, not the one just
    // derived: swapping the two turns every breach into a message reading
    // "OK to OK".
    expect(payload.previousSeverity).toBe("OK");
    expect(payload.value).toBe(250);
    expect(payload.threshold).toBe(100);
    expect(payload.alertId).toBe("hot-1");
    expect(payload.projectId).toBe("proj-1");
    // The pre-emission state rides along, so a non-delivery can be undone later.
    // No claim token: it is rewritten every minute and the delivery that would
    // match on it retries for half an hour.
    expect(payload.emission).toEqual({
      evaluatedAt: BOUNDARY.getTime(),
      priorSeverity: "OK",
      priorSeverityChangedAt: changedAt.getTime(),
      priorAlertedAt: null,
    });

    // Dated by the tick's window rather than the moment it sent, and the edges
    // the evaluator measured over are the edges the message quotes — otherwise
    // the reader cannot check the number.
    expect(payload.windowEnd.getTime()).toBe(WINDOW_END.getTime());
    expect(payload.windowStart.getTime()).toBe(WINDOW_START_10M.getTime());
    const request = evaluateAlerts.mock.calls[0][0];
    expect(request.windowStart.getTime()).toBe(payload.windowStart.getTime());
    expect(request.windowEnd.getTime()).toBe(payload.windowEnd.getTime());
  });

  it("pages on the recovery out of ALERT, which is the same fields the other way round", async () => {
    const alertedAt = new Date("2026-08-12T10:20:00.000Z");
    claimDueAlerts.mockResolvedValue([
      claimWith("cooled-1", {
        state: { severity: "ALERT", severityChangedAt: alertedAt, alertedAt },
      }),
    ]);
    evaluateAlerts.mockResolvedValue([okResult("cooled-1")]);

    await runAlertTick(NOW);

    const [payload] = enqueueAlertNotification.mock.calls[0];
    expect(payload.severity).toBe("OK");
    expect(payload.previousSeverity).toBe("ALERT");
    expect(payload.value).toBe(5);
  });

  it("settles without paging a severity that did not change, or a window with nothing in it", async () => {
    claimDueAlerts.mockResolvedValue([
      claimWith("steady-1", {
        state: { severity: "ALERT", severityChangedAt: BOUNDARY, alertedAt: BOUNDARY },
      }),
      claimWith("quiet-1"),
    ]);
    evaluateAlerts.mockResolvedValue([
      breachResult("steady-1"),
      { alert_id: "quiet-1", value: null, row_count: 0, error: null, errorKind: null },
    ]);

    await runAlertTick(NOW);

    expect(completeAlertEvaluation.mock.calls.map(([c]) => c.state.severity)).toEqual([
      "ALERT",
      "NO_DATA",
    ]);
    expect(enqueueAlertNotification).not.toHaveBeenCalled();
  });

  it("reads an empty window the way each rule asked for it", async () => {
    claimDueAlerts.mockResolvedValue([
      claimWith("silent-1", { noDataMode: "NOTIFY" }),
      claimWith("floor-1", { noDataMode: "ZERO", thresholdOperator: "<", threshold: 1 }),
    ]);
    evaluateAlerts.mockResolvedValue([
      { alert_id: "silent-1", value: null, row_count: 0, error: null, errorKind: null },
      { alert_id: "floor-1", value: null, row_count: 0, error: null, errorKind: null },
    ]);

    await runAlertTick(NOW);

    expect(completeAlertEvaluation.mock.calls.map(([c]) => c.state.severity)).toEqual([
      "NO_DATA",
      "ALERT",
    ]);
    expect(
      enqueueAlertNotification.mock.calls.map(([p]) => [p.alertId, p.severity, p.value]),
    ).toEqual([
      ["silent-1", "NO_DATA", null],
      ["floor-1", "ALERT", null],
    ]);
  });

  it("writes back against the state it decided from, not the claim token alone", async () => {
    // A delivery that gives up mid-tick puts the rule back where it was before
    // the emission and never touches the claim token doing it, so the token on
    // its own cannot tell this result from one nothing has invalidated.
    const alertedAt = new Date("2026-08-12T10:20:00.000Z");
    claimDueAlerts.mockResolvedValue([
      claimWith("hot-1", { state: { severity: "ALERT", severityChangedAt: alertedAt, alertedAt } }),
    ]);
    evaluateAlerts.mockResolvedValue([breachResult("hot-1")]);

    await runAlertTick(NOW);

    expect(completeAlertEvaluation.mock.calls[0][0].previousAlertedAt).toBe(alertedAt);
  });

  it("suppresses only the rule whose CAS missed, and pages its siblings", async () => {
    // False means another worker re-claimed the rule, or the owner paused it
    // while this evaluation was in flight. Paging anyway announces a severity
    // that was never recorded, against a rule this tick no longer owns.
    completeAlertEvaluation.mockImplementation(async (completion) => completion.alertId !== "lost");
    claimDueAlerts.mockResolvedValue([claimWith("lost"), claimWith("held")]);
    evaluateAlerts.mockResolvedValue([breachResult("lost"), breachResult("held")]);

    await runAlertTick(NOW);

    expect(completeAlertEvaluation).toHaveBeenCalledTimes(2);
    expect(enqueueAlertNotification.mock.calls.map(([p]) => p.alertId)).toEqual(["held"]);
  });
});

describe("runAlertTick — a run that produced no measurement", () => {
  it("leaves the same reason on every rule a failed request covered", async () => {
    claimDueAlerts.mockResolvedValue([claimWith("a"), claimWith("b")]);
    evaluateAlerts.mockRejectedValue(new Error("fetch failed"));

    await runAlertTick(NOW);

    expect(completeAlertEvaluation).not.toHaveBeenCalled();
    const failures = recordAlertEvaluationFailure.mock.calls.map(([f]) => f);
    expect(failures.map((f) => f.alertId)).toEqual(["a", "b"]);
    for (const failure of failures) {
      expect(failure.claimStamp).toBe(NOW);
      expect(failure.error.message).toContain("evaluation request failed: fetch failed");
    }
  });

  it("records the rule the evaluator errored on, and the one it never answered about", async () => {
    claimDueAlerts.mockResolvedValue([claimWith("a"), claimWith("missing"), claimWith("b")]);
    evaluateAlerts.mockResolvedValue([
      {
        alert_id: "a",
        value: null,
        row_count: 0,
        error: "column does not exist",
        errorKind: "query",
      },
      breachResult("b"),
    ]);

    await runAlertTick(NOW);

    const failures = recordAlertEvaluationFailure.mock.calls.map(([f]) => f);
    expect(failures.map((f) => f.alertId)).toEqual(["a", "missing"]);
    expect(failures[0].error.message).toBe("column does not exist");
    expect(failures[1].error.message).toContain("no result");
    expect(completeAlertEvaluation.mock.calls.map(([c]) => c.alertId)).toEqual(["b"]);
  });

  it("records the reason when the state write itself throws", async () => {
    claimDueAlerts.mockResolvedValue([claimWith("a")]);
    evaluateAlerts.mockResolvedValue([breachResult("a")]);
    completeAlertEvaluation.mockRejectedValue(new Error("pool timeout"));

    await expect(runAlertTick(NOW)).resolves.toBeUndefined();

    expect(recordAlertEvaluationFailure.mock.calls[0][0].error.message).toContain("pool timeout");
  });

  it("gives the rule back its pre-emission state when the enqueue fails", async () => {
    const changedAt = new Date("2026-08-12T09:00:00.000Z");
    claimDueAlerts.mockResolvedValue([
      claimWith("hot-1", {
        state: { severity: "OK", severityChangedAt: changedAt, alertedAt: null },
      }),
      claimWith("hot-2"),
    ]);
    evaluateAlerts.mockResolvedValue([breachResult("hot-1"), breachResult("hot-2")]);
    enqueueAlertNotification.mockRejectedValueOnce(new Error("enqueue timed out after 2000ms"));

    await expect(runAlertTick(NOW)).resolves.toBeUndefined();

    expect(revertAlertEmissionState).toHaveBeenCalledTimes(1);
    const [revert] = revertAlertEmissionState.mock.calls[0];
    expect(revert.alertId).toBe("hot-1");
    // Matched on what the emission a moment ago wrote, not on the claim token.
    expect(revert.emittedSeverity).toBe("ALERT");
    expect(revert.emittedAt.getTime()).toBe(BOUNDARY.getTime());
    expect(revert.priorState).toEqual({
      severity: "OK",
      severityChangedAt: changedAt,
      alertedAt: null,
    });
    expect(revert.error.message).toContain("enqueue-failed");
    // The revert is its own write rather than a second completion, and reaching
    // it is not itself a failure of the run.
    expect(completeAlertEvaluation).toHaveBeenCalledTimes(2);
    expect(recordAlertEvaluationFailure).not.toHaveBeenCalled();
    // The tick, and the rules it has left, survive the failed enqueue.
    expect(enqueueAlertNotification).toHaveBeenCalledTimes(2);
  });
});

describe("runAlertTick — how wide one tick fans out", () => {
  function widthTracker() {
    const state = { current: 0, peak: 0 };
    return {
      state,
      async enter(): Promise<void> {
        state.current += 1;
        state.peak = Math.max(state.peak, state.current);
        await yieldToLoop();
        state.current -= 1;
      },
    };
  }

  it("never has more requests in flight than the bound, over every group and chunk", async () => {
    const tracker = widthTracker();
    const projects = 6;
    const chunksPerProject = 3;
    claimDueAlerts.mockResolvedValue(
      Array.from({ length: projects }, (_, project) =>
        Array.from({ length: ALERT_EVALUATION_CHUNK_SIZE * chunksPerProject }, (_, index) =>
          claimWith(`p${project}-a${index}`, { projectId: `proj-${project}` }),
        ),
      ).flat(),
    );
    evaluateAlerts.mockImplementation(async (request) => {
      await tracker.enter();
      return request.alerts.map((spec) => okResult(spec.alert_id));
    });

    await runAlertTick(NOW);

    // One bound over the whole tick: nested bounds multiply.
    expect(evaluateAlerts).toHaveBeenCalledTimes(projects * chunksPerProject);
    expect(tracker.state.peak).toBe(ALERT_EVALUATION_CONCURRENCY);
    expect(tracker.state.current).toBe(0);
  });

  it("counts a single rule's own task against the same bound", async () => {
    const tracker = widthTracker();
    // Every unsendable rule is its own task rather than part of a batch, so this
    // is the fan-out the chunking never covers.
    claimDueAlerts.mockResolvedValue(
      Array.from({ length: 40 }, (_, index) =>
        claimFiltered(`bad-${index}`, [{ field: "status", op: "any of", value: "error" }]),
      ),
    );
    parkAlertRule.mockImplementation(async () => {
      await tracker.enter();
      return true;
    });

    await runAlertTick(NOW);

    expect(parkAlertRule).toHaveBeenCalledTimes(40);
    expect(tracker.state.peak).toBe(ALERT_EVALUATION_CONCURRENCY);
    // A tick with nothing sendable in it sends no request at all.
    expect(evaluateAlerts).not.toHaveBeenCalled();
    expect(completeAlertEvaluation).not.toHaveBeenCalled();
  });
});

describe("startAlertScheduler", () => {
  const withEnv = async (value: string | undefined, run: () => Promise<void>): Promise<void> => {
    const previous = process.env.ALERTS_SCHEDULER_ENABLED;
    if (value === undefined) delete process.env.ALERTS_SCHEDULER_ENABLED;
    else process.env.ALERTS_SCHEDULER_ENABLED = value;
    try {
      await run();
    } finally {
      if (previous === undefined) delete process.env.ALERTS_SCHEDULER_ENABLED;
      else process.env.ALERTS_SCHEDULER_ENABLED = previous;
    }
  };

  it("schedules nothing at all when the kill switch is off", async () => {
    await withEnv("off", async () => {
      expect(startAlertScheduler()).toBeUndefined();
      expect(cronSchedule).not.toHaveBeenCalled();
    });
  });

  it("schedules nothing at all when the kill switch cannot be read", async () => {
    // A typo in a switch reached for to stop the paging must not keep paging.
    await withEnv("disabeld", async () => {
      expect(startAlertScheduler()).toBeUndefined();
      expect(cronSchedule).not.toHaveBeenCalled();
    });
  });

  it("runs a tick a minute, skipping a minute the previous tick is still running", async () => {
    // The latch is what a hung enqueue used to leave stuck: once it never
    // cleared, every later minute was skipped until the process restarted.
    let release: (() => void) | undefined;
    claimDueAlerts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );

    await withEnv("true", async () => {
      startAlertScheduler();
      expect(cronSchedule.mock.calls[0][0]).toBe("* * * * *");
      const handler = cronSchedule.mock.calls[0][1];

      const first = handler();
      await handler();
      expect(claimDueAlerts).toHaveBeenCalledTimes(1);

      release?.();
      await first;

      await handler();
      expect(claimDueAlerts).toHaveBeenCalledTimes(2);
    });
  });

  it("re-reads the switch each tick rather than holding the one it started with", async () => {
    // Held from boot, stopping the paging meant restarting the worker, which
    // takes the detector run, RCA and digest consumers down with it.
    await withEnv("true", async () => {
      startAlertScheduler();
      const handler = cronSchedule.mock.calls[0][1];

      await handler();
      expect(claimDueAlerts).toHaveBeenCalledTimes(1);

      await withEnv("off", async () => {
        await handler();
        await handler();
      });
      expect(claimDueAlerts).toHaveBeenCalledTimes(1);

      // And back: nothing was torn down, so the next minute simply ticks again.
      await handler();
      expect(claimDueAlerts).toHaveBeenCalledTimes(2);
    });
  });

  it("clears the latch even when the tick throws", async () => {
    claimDueAlerts.mockResolvedValueOnce([{ claimStamp: NOW } as unknown as ClaimedAlert]);

    await withEnv("true", async () => {
      startAlertScheduler();
      const handler = cronSchedule.mock.calls[0][1];

      await handler();
      await handler();

      expect(claimDueAlerts).toHaveBeenCalledTimes(2);
    });
  });

  it("holds shutdown open until an in-flight tick finishes", async () => {
    // The exit this covers: `completeAlertEvaluation` committed, the process
    // died before the enqueue, and the first page of the incident never sends.
    let release: (() => void) | undefined;
    claimDueAlerts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );

    await withEnv("true", async () => {
      const scheduler = startAlertScheduler();
      const handler = cronSchedule.mock.calls[0][1];
      const ticking = handler();

      let isIdle: boolean | undefined;
      const drained = scheduler?.waitForIdle(60_000).then((result) => {
        isIdle = result;
      });
      await yieldToLoop();
      expect(isIdle).toBeUndefined();

      release?.();
      await ticking;
      await drained;
      expect(isIdle).toBe(true);
    });
  });

  it("gives up on the drain at the bound rather than outliving the stop grace", async () => {
    vi.useFakeTimers();
    try {
      claimDueAlerts.mockImplementationOnce(() => new Promise(() => {}));

      await withEnv("true", async () => {
        const scheduler = startAlertScheduler();
        const handler = cronSchedule.mock.calls[0][1];
        void handler();

        const drained = scheduler?.waitForIdle(5_000);
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(drained).resolves.toBe(false);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers an idle scheduler immediately, without arming the bound", async () => {
    await withEnv("true", async () => {
      const scheduler = startAlertScheduler();
      await expect(scheduler?.waitForIdle(0)).resolves.toBe(true);
    });
  });

  it("never claims from a callback dispatched after stop", async () => {
    // node-cron's stop() is only clearTimeout, so a callback already handed to
    // the event loop still runs; the handler itself has to refuse.
    await withEnv("true", async () => {
      const scheduler = startAlertScheduler();
      const handler = cronSchedule.mock.calls[0][1];
      scheduler?.stop();

      await handler();

      expect(claimDueAlerts).not.toHaveBeenCalled();
      expect(cronSchedule.mock.results[0].value.stop).toHaveBeenCalledTimes(1);
      await expect(scheduler?.waitForIdle(0)).resolves.toBe(true);
    });
  });
});
