import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postMessage = vi.fn();
const createSlackClient = vi.fn((_token: string) => ({ chat: { postMessage } }));
const buildAlertBlocks = vi.fn((_params: unknown) => ({
  blocks: [{ type: "section", text: { type: "mrkdwn", text: "alert" } }],
  color: "#c0362c",
  text: "[ALERT] rule",
}));
const buildAlertClosedBlocks = vi.fn((_params: unknown) => ({
  blocks: [{ type: "section", text: { type: "mrkdwn", text: "closed" } }],
  color: "#1a7f4e",
  text: "[OK] rule",
}));
const userFindUnique = vi.fn<(args: unknown) => Promise<Record<string, unknown> | null>>();
const findUnique = vi.fn();
const hasEntitlement = vi.fn();
const decryptKey = vi.fn((s: string) => `decrypted(${s})`);
const logInfo = vi.fn();
const logError = vi.fn();
// Without this the rule-state writes every non-delivery depends on land on an
// undefined client, and the error is swallowed by the guard around them.
const alertUpdateMany = vi.fn<(args: PrismaUpdateArgs) => Promise<{ count: number }>>();
// The rule is re-read before anything is sent, so a job whose rule was paused or
// deleted during a backoff needs a row here as much as the writes need a client.
const alertFindUnique = vi.fn<(args: unknown) => Promise<Record<string, unknown> | null>>();

interface PrismaUpdateArgs {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

vi.mock("@traceroot/slack", () => ({
  createSlackClient: (token: string) => createSlackClient(token),
  buildAlertBlocks: (params: unknown) => buildAlertBlocks(params),
  buildAlertClosedBlocks: (params: unknown) => buildAlertClosedBlocks(params),
}));
// Spread over the real module rather than replacing it: the state machine this
// suite drives to prove the loop terminates reads its own constants from here.
vi.mock("@traceroot/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@traceroot/core")>()),
  decryptKey: (s: string) => decryptKey(s),
  hasEntitlement: (...a: unknown[]) => hasEntitlement(...a),
  prisma: {
    project: { findUnique: (...a: unknown[]) => findUnique(...a) },
    alert: {
      updateMany: (args: PrismaUpdateArgs) => alertUpdateMany(args),
      findUnique: (args: unknown) => alertFindUnique(args),
    },
    user: { findUnique: (args: unknown) => userFindUnique(args) },
  },
}));
vi.mock("../../alerts/log.js", () => ({
  logInfo: (...a: unknown[]) => logInfo(...a),
  logError: (...a: unknown[]) => logError(...a),
}));

const queueAdd = vi.fn();
vi.mock("../../queues/alert-notification-queue.js", () => ({
  ALERT_NOTIFICATION_QUEUE: "alert-notification",
  createAlertNotificationQueue: () => ({ add: queueAdd }),
  createRedisConnection: (options?: unknown) => ({ connection: true, options }),
  alertNotificationBackoff: (attemptsMade: number) => attemptsMade * 1000,
  isAlertCloseJob: (data: { kind?: string }) => data.kind === "close",
}));

const workerHandlers = new Map<string, (...a: unknown[]) => unknown>();
const workerConstructed = vi.fn();
class FakeWorker {
  constructor(name: string, processor: (job: unknown) => unknown, opts: unknown) {
    workerConstructed(name, processor, opts);
  }
  on(event: string, handler: (...a: unknown[]) => unknown) {
    workerHandlers.set(event, handler);
    return this;
  }
}
vi.mock("bullmq", () => ({ Queue: class {}, Worker: FakeWorker }));

const job = {
  alertId: "al_1",
  projectId: "proj_1",
  name: "Checkout p95 latency",
  severity: "ALERT" as const,
  previousSeverity: "OK" as const,
  value: 1834,
  threshold: 1500,
  thresholdOperator: ">" as const,
  measure: "latency",
  aggregation: "p95",
  window: "30m" as const,
  windowStart: Date.UTC(2026, 5, 23, 12, 0, 0),
  windowEnd: Date.UTC(2026, 5, 23, 12, 30, 0),
};

const emission = {
  evaluatedAt: Date.UTC(2026, 5, 23, 12, 30, 0),
  priorSeverity: "OK" as const,
  priorSeverityChangedAt: Date.UTC(2026, 5, 23, 9, 0, 0),
  priorAlertedAt: null,
};

const compensableJob = { ...job, emission };

const closeMarker = {
  reason: "edited" as const,
  actorUserId: "user_1",
  at: "2026-06-23T12:31:00.000Z",
};
const closeJob = {
  kind: "close" as const,
  alertId: "al_1",
  projectId: "proj_1",
  name: "Checkout p95 latency",
  ...closeMarker,
};

const closeRestores = () =>
  alertUpdateMany.mock.calls.map(([args]) => args).filter((args) => "pendingClose" in args.data);

const alertRow = (overrides: Record<string, unknown> = {}) => ({
  id: "al_1",
  status: "ACTIVE",
  severity: "ALERT",
  alertedAt: new Date(emission.evaluatedAt),
  // Half an hour of retries behind it, so every tick since has rewritten this.
  lastClaimedAt: new Date(emission.evaluatedAt + 30 * 60_000),
  ...overrides,
});

const writesLandOn = (row: Record<string, unknown>): void => {
  alertUpdateMany.mockImplementation(async ({ where }) => {
    const matches = Object.entries(where).every(([field, expected]) => {
      const actual = row[field];
      return expected instanceof Date && actual instanceof Date
        ? expected.getTime() === actual.getTime()
        : expected === actual;
    });
    return { count: matches ? 1 : 0 };
  });
};

const notifyWrites = () =>
  alertUpdateMany.mock.calls
    .map(([args]) => args)
    .filter((args) => "lastNotifyStatus" in args.data);

const stateWrites = () =>
  alertUpdateMany.mock.calls.map(([args]) => args).filter((args) => "severity" in args.data);

const projectRow = (overrides: Record<string, unknown> = {}) => ({
  alertConfig: null,
  workspace: {
    billingPlan: "starter",
    slackIntegration: { channelId: "C_WORKSPACE", botToken: "enc-tok" },
  },
  ...overrides,
});

const noChannelRow = projectRow({ workspace: { billingPlan: "starter", slackIntegration: null } });
const noTokenRow = projectRow({
  alertConfig: { slackChannelId: "C_PROJECT" },
  workspace: { billingPlan: "starter", slackIntegration: { channelId: null, botToken: null } },
});
const slackRefuses = () => postMessage.mockRejectedValue(slackPlatformError("channel_not_found"));
const failDecryption = () =>
  decryptKey.mockImplementationOnce(() => {
    throw new Error("bad key");
  });

const importModule = async () => await import("../alert-slack.js");

beforeEach(() => {
  postMessage.mockReset().mockResolvedValue({ ok: true, ts: "1.2" });
  createSlackClient.mockClear();
  buildAlertBlocks.mockClear();
  buildAlertClosedBlocks.mockClear();
  userFindUnique.mockReset().mockResolvedValue({ name: "Ada", email: "ada@example.com" });
  findUnique.mockReset().mockResolvedValue(projectRow());
  hasEntitlement.mockReset().mockReturnValue(true);
  decryptKey.mockClear();
  logInfo.mockReset();
  logError.mockReset();
  alertUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  // The row as the emission left it: a job is only sent while the rule still
  // reads that way, so the default row is the one this job's emission wrote.
  alertFindUnique.mockReset().mockResolvedValue(alertRow());
  queueAdd.mockReset().mockResolvedValue(undefined);
  workerHandlers.clear();
});
const slackHttpError = (statusCode: number) => ({ code: "slack_webapi_http_error", statusCode });
const slackPlatformError = (error: string) => ({
  code: "slack_webapi_platform_error",
  data: { ok: false, error },
});

describe("isRetryableSlackError", () => {
  it("classifies each failure by whether a later attempt could still deliver it", async () => {
    const { isRetryableSlackError } = await importModule();
    const cases: [unknown, boolean][] = [
      [{ code: "slack_webapi_rate_limited", retryAfter: 30 }, true],
      [slackHttpError(429), true],
      [slackHttpError(503), true],
      [slackPlatformError("internal_error"), true],
      [Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), true],
      // an unrecognised failure must never silently drop an alert
      ["boom", true],
      [undefined, true],
      // these will fail identically next time, so retrying only burns attempts
      [slackHttpError(400), false],
      [slackHttpError(401), false],
      [slackHttpError(404), false],
      [slackPlatformError("channel_not_found"), false],
      [slackPlatformError("invalid_auth"), false],
      [slackPlatformError("invalid_blocks"), false],
      // the HTTP status decides when a 4xx also carries a transient-looking code
      [{ statusCode: 400, data: { ok: false, error: "internal_error" } }, false],
      // but a rate-limit code outranks it: that is the one Slack asks us to back off on
      [{ code: "slack_webapi_rate_limited", statusCode: 429 }, true],
    ];

    for (const [error, retryable] of cases) {
      expect({ error, retryable: isRetryableSlackError(error) }).toMatchObject({ retryable });
    }
  });
});

describe("enqueueAlertNotification", () => {
  const payloadOf = (overrides: Record<string, unknown> = {}) => ({
    ...job,
    windowStart: new Date(job.windowStart),
    windowEnd: new Date(job.windowEnd),
    ...overrides,
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serializes the window bounds to epoch ms and keys the job on the evaluation", async () => {
    const { enqueueAlertNotification } = await importModule();
    await enqueueAlertNotification(payloadOf({ emission }));
    await enqueueAlertNotification(payloadOf({ emission }));
    await enqueueAlertNotification(payloadOf({ windowEnd: new Date(job.windowEnd + 60_000) }));

    const [name, payload, options] = queueAdd.mock.calls[0];
    // JSON carries no Date, and the claim rides along so a non-delivery can be
    // undone against it.
    expect(payload.windowStart).toBe(job.windowStart);
    expect(payload.windowEnd).toBe(job.windowEnd);
    expect(payload.severity).toBe("ALERT");
    expect(payload.emission).toEqual(emission);

    // Without a jobId, an `add` that timed out after Redis had accepted it
    // enqueues a second copy of the same page on the retry.
    expect(options).toEqual({ jobId: `alert-al_1-${job.windowEnd}` });
    expect(options.jobId).toBe(name);
    const keys = queueAdd.mock.calls.map(([, , o]) => o.jobId);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("rejects rather than hanging when the connection buffers the add indefinitely", async () => {
    // ioredis buffers commands issued while disconnected, so the add neither
    // resolves nor rejects: the tick hangs and its latch never clears.
    vi.useFakeTimers();
    queueAdd.mockImplementation(() => new Promise(() => {}));
    const { enqueueAlertNotification } = await importModule();

    const enqueued = enqueueAlertNotification(payloadOf());
    const settled = expect(enqueued).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;

    expect(queueAdd).toHaveBeenCalledTimes(3);
  });
});

describe("sendAlertNotification", () => {
  it("hands the rule's filters to the message builder", async () => {
    const { sendAlertNotification } = await importModule();
    const filters = [{ field: "span_kind", op: "=", value: "LLM" }];
    await sendAlertNotification({ ...job, filters });
    const params = buildAlertBlocks.mock.calls[0][0] as { filters?: unknown };
    expect(params.filters).toEqual(filters);
  });

  it("posts the built message as a coloured attachment with unfurling off", async () => {
    const { sendAlertNotification } = await importModule();
    await sendAlertNotification(job);

    expect(findUnique.mock.calls[0][0]).toMatchObject({ where: { id: "proj_1" } });
    expect(createSlackClient).toHaveBeenCalledWith("decrypted(enc-tok)");
    const arg = postMessage.mock.calls[0][0];
    expect(arg.channel).toBe("C_WORKSPACE");
    expect(arg.attachments).toEqual([
      { color: "#c0362c", blocks: [{ type: "section", text: { type: "mrkdwn", text: "alert" } }] },
    ]);
    expect(arg.text).toBe("[ALERT] rule");
    expect(arg.unfurl_links).toBe(false);
    expect(arg.unfurl_media).toBe(false);
    expect(logInfo.mock.calls[0][0]).toContain(
      "alert=al_1 project=proj_1 severity=ALERT channel=C_WORKSPACE",
    );

    // The builder takes dates back, having been handed epoch ms over the queue.
    const params = buildAlertBlocks.mock.calls[0][0] as { windowStart: Date; windowEnd: Date };
    expect(params.windowStart.getTime()).toBe(job.windowStart);
    // A job from before filters travelled renders as an unfiltered rule.
    expect((params as { filters?: unknown }).filters).toEqual([]);
    expect(params.windowEnd.getTime()).toBe(job.windowEnd);
    expect(params).toMatchObject({ alertId: "al_1", measure: "latency", aggregation: "p95" });
  });

  it("prefers the project channel, falling back to the workspace default", async () => {
    findUnique.mockResolvedValue(projectRow({ alertConfig: { slackChannelId: "C_PROJECT" } }));
    const { sendAlertNotification } = await importModule();
    await sendAlertNotification(job);
    expect(postMessage.mock.calls[0][0].channel).toBe("C_PROJECT");

    findUnique.mockResolvedValue(projectRow({ alertConfig: { slackChannelId: null } }));
    await sendAlertNotification(job);
    expect(postMessage.mock.calls[1][0].channel).toBe("C_WORKSPACE");
  });

  it("records a sent page as DELIVERED, against the rule and nothing else", async () => {
    const { sendAlertNotification } = await importModule();
    await sendAlertNotification(compensableJob);

    expect(notifyWrites()).toHaveLength(1);
    const [write] = notifyWrites();
    expect(write.where).toEqual({ id: "al_1" });
    expect(write.data.lastNotifyStatus).toBe("DELIVERED");
    expect(write.data.lastNotifyError).toBeNull();
    expect(write.data.lastNotifySeverity).toBe("ALERT");
    expect(write.data.lastNotifyAt).toBeInstanceOf(Date);
    // A sent page is never taken back.
    expect(stateWrites()).toHaveLength(0);
  });

  it("gives the page back when the project it belonged to is gone", async () => {
    const reason = "project-missing";
    findUnique.mockResolvedValue(null);
    const { sendAlertNotification } = await importModule();
    await expect(sendAlertNotification(compensableJob)).resolves.toBeUndefined();

    const [revert] = stateWrites();
    // The pair the emission itself wrote is the predicate; the claim token is rewritten every tick.
    expect(revert.where).toEqual({
      id: "al_1",
      status: "ACTIVE",
      severity: "ALERT",
      alertedAt: new Date(emission.evaluatedAt),
    });
    expect(revert.data).toMatchObject({
      severity: "OK",
      alertedAt: null,
      severityChangedAt: new Date(emission.priorSeverityChangedAt),
    });
    // The evaluations between the emission and this failure really happened.
    expect(revert.data).not.toHaveProperty("lastEvaluatedAt");
    expect(revert.data.lastError).toContain(reason);

    const [outcome] = notifyWrites();
    expect(outcome.data.lastNotifyStatus).toBe("COMPENSATED");
    expect(outcome.data.lastNotifyError).toContain(reason);
    // The revert's CAS just won, so nothing newer can have landed: recorded unconditionally.
    expect(outcome.where).toEqual({ id: "al_1" });
  });

  it.each([
    ["the plan lost slack", () => hasEntitlement.mockReturnValue(false), "no-entitlement"],
    ["no channel is configured", () => findUnique.mockResolvedValue(noChannelRow), "no-channel"],
    [
      "the integration lost its token",
      () => findUnique.mockResolvedValue(noTokenRow),
      "no-bot-token",
    ],
    ["the stored token will not decrypt", failDecryption, "bot-token-undecryptable"],
    ["Slack refuses the message", slackRefuses, "permanent-slack-error"],
  ])("keeps the page and says what to fix when %s", async (_label, arrange, reason) => {
    // Nothing a later attempt or a later emission gets past, so giving the page
    // back would only hand the next tick the same breach to emit into the same
    // wall. The rule keeps the severity its evaluation produced.
    arrange();
    const { sendAlertNotification } = await importModule();
    await expect(sendAlertNotification(compensableJob)).resolves.toBeUndefined();

    expect(stateWrites()).toHaveLength(0);
    expect(notifyWrites()).toHaveLength(1);
    expect(notifyWrites()[0].data.lastNotifyStatus).toBe("FAILED");
    expect(notifyWrites()[0].data.lastNotifyError).toContain(reason);
    // A permanent failure reports on the current emission, so it lands unconditionally:
    // an older emission's slow delivery may have stamped a later lastNotifyAt.
    expect(notifyWrites()[0].where).toEqual({ id: "al_1" });
  });

  it("stops the every-minute emit-and-take-back loop for a rule with no Slack channel", async () => {
    // Reachable by saving a rule without connecting Slack and breaching it. The
    // rollback restored exactly the severity `shouldEmit` reads for a fresh
    // breach, so the next tick emitted again, failed again, and so on: two row
    // writes and a job a minute, forever, and never a page.
    const stored: Record<string, unknown> = alertRow();
    alertUpdateMany.mockImplementation(async ({ where, data }) => {
      const matches = Object.entries(where).every(([field, expected]) => {
        const actual = stored[field];
        return expected instanceof Date && actual instanceof Date
          ? expected.getTime() === actual.getTime()
          : expected === actual;
      });
      if (matches) Object.assign(stored, data);
      return { count: matches ? 1 : 0 };
    });
    alertFindUnique.mockImplementation(async () => ({ ...stored }));
    findUnique.mockResolvedValue(noChannelRow);

    const { sendAlertNotification } = await importModule();
    const { applyAlertStateMachine } = await import("../../alerts/severity-state-machine.js");
    await sendAlertNotification(compensableJob);

    // Still breaching a minute later, and the row still records the page it
    // raised, so this tick and every tick after it has nothing new to say.
    const nextTick = applyAlertStateMachine(
      {
        severity: stored.severity as "ALERT",
        severityChangedAt: null,
        alertedAt: stored.alertedAt as Date | null,
      },
      "ALERT",
      new Date(emission.evaluatedAt + 60_000),
      { mode: "OFF" },
    );
    expect(nextTick.emit).toBe(false);
    // And the owner is not left guessing why nothing arrived.
    expect(stored.lastNotifyStatus).toBe("FAILED");
    expect(stored.lastNotifyError).toBe("no-channel");
  });

  it("drops a job whose emission a later evaluation has already replaced", async () => {
    // Attempts run out to half an hour: this recovery is still retrying when
    // the breach returns and pages. Sending it now would leave "recovered" as
    // the channel's last word on a rule that is in ALERT.
    alertFindUnique.mockResolvedValue(
      alertRow({ severity: "ALERT", alertedAt: new Date(emission.evaluatedAt + 5 * 60_000) }),
    );
    const { sendAlertNotification } = await importModule();
    await sendAlertNotification({ ...compensableJob, severity: "OK", previousSeverity: "ALERT" });

    expect(postMessage).not.toHaveBeenCalled();
    // The state belongs to the emission that replaced this one, so it is left
    // alone; the outcome is held behind anything that emission has recorded.
    expect(stateWrites()).toHaveLength(0);
    expect(notifyWrites()).toHaveLength(1);
    expect(notifyWrites()[0].data.lastNotifyStatus).toBe("SUPERSEDED");
    expect(notifyWrites()[0].where).toMatchObject({
      OR: [{ lastNotifyAt: null }, { lastNotifyAt: { lt: new Date(emission.evaluatedAt) } }],
    });
    expect(logInfo.mock.calls[0][0]).toContain("reason=superseded");
  });

  it("sends for the emission the rule still reads as its own", async () => {
    // The severity has not moved and the stamp is this job's, so half an hour
    // of retries later this is still the page the rule is waiting on.
    alertFindUnique.mockResolvedValue(alertRow());
    const { sendAlertNotification } = await importModule();
    await sendAlertNotification(compensableJob);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(notifyWrites()[0].data.lastNotifyStatus).toBe("DELIVERED");
  });

  it("gives the page back to a rule the half hour of retries kept re-claiming", async () => {
    // The regression: the delivery budget outruns the claim token many times
    // over, so a compensation keyed to that token matched no row on exactly the
    // path it exists for, and with renotify off the breach was never announced.
    writesLandOn(alertRow());
    findUnique.mockResolvedValue(null);
    const { sendAlertNotification } = await importModule();
    await sendAlertNotification(compensableJob);

    expect(stateWrites()).toHaveLength(1);
    expect(notifyWrites()[0].data.lastNotifyStatus).toBe("COMPENSATED");
  });

  it("says FAILED when the alert has moved on since the emission it undoes", async () => {
    // The breach resolved on its own while Slack was down, so the rule is not
    // this job's to give back: it still reads as paged, which is a different
    // thing to tell the owner than a page taken back.
    writesLandOn(alertRow({ severity: "OK" }));
    findUnique.mockResolvedValue(null);
    const { sendAlertNotification } = await importModule();
    await sendAlertNotification(compensableJob);

    expect(stateWrites()).toHaveLength(1);
    expect(notifyWrites()[0].data.lastNotifyStatus).toBe("FAILED");
    // The missed CAS is the proof the row is newer, so this FAILED must not bury a
    // DELIVERED the emission that moved it on has recorded since.
    expect(notifyWrites()[0].where).toEqual({
      id: "al_1",
      OR: [{ lastNotifyAt: null }, { lastNotifyAt: { lt: new Date(emission.evaluatedAt) } }],
    });
  });

  it.each([
    ["paused", { status: "PAUSED" }, "alert-paused"],
    ["deleted", null, "alert-deleted"],
  ])("sends nothing for a rule %s while the job waited", async (_label, row, reason) => {
    alertFindUnique.mockResolvedValue(row);
    const { sendAlertNotification } = await importModule();
    await sendAlertNotification(compensableJob);

    expect(alertFindUnique.mock.calls[0][0]).toMatchObject({ where: { id: "al_1" } });
    expect(postMessage).not.toHaveBeenCalled();
    // The rule's own status decides this, so the project is never even read.
    expect(findUnique).not.toHaveBeenCalled();
    expect(notifyWrites()).toHaveLength(1);
    expect(notifyWrites()[0].data.lastNotifyStatus).toBe("FAILED");
    expect(notifyWrites()[0].data.lastNotifyError).toBe(reason);
    expect(notifyWrites()[0].data.lastNotifySeverity).toBe("ALERT");
    // Pausing is itself something that happened to the rule, and a deleted rule
    // has nothing left to re-emit, so neither is rolled back.
    expect(stateWrites()).toHaveLength(0);
    expect(logInfo.mock.calls[0][0]).toContain(`reason=${reason}`);
  });

  it.each([
    ["paused", alertRow({ status: "PAUSED" }), "alert-paused"],
    ["deleted", null, "alert-deleted"],
  ])(
    "sends nothing for a rule %s while the channel was being resolved",
    async (_label, rowAtSend, reason) => {
      // The first read let the job through; the pause landed during the channel
      // and token round trips. The kill switch has to hold at the send itself.
      alertFindUnique.mockResolvedValueOnce(alertRow()).mockResolvedValueOnce(rowAtSend);
      const { sendAlertNotification } = await importModule();
      await sendAlertNotification(compensableJob);

      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(alertFindUnique).toHaveBeenCalledTimes(2);
      expect(postMessage).not.toHaveBeenCalled();
      expect(notifyWrites()).toHaveLength(1);
      expect(notifyWrites()[0].data.lastNotifyStatus).toBe("FAILED");
      expect(notifyWrites()[0].data.lastNotifyError).toBe(reason);
      expect(stateWrites()).toHaveLength(0);
      expect(logInfo.mock.calls[0][0]).toContain(`reason=${reason} at=send`);
    },
  );

  it("drops, at the send, an emission a later evaluation replaced during the round trips", async () => {
    alertFindUnique
      .mockResolvedValueOnce(alertRow())
      .mockResolvedValueOnce(alertRow({ alertedAt: new Date(emission.evaluatedAt + 60_000) }));
    const { sendAlertNotification } = await importModule();
    await sendAlertNotification(compensableJob);

    expect(postMessage).not.toHaveBeenCalled();
    expect(notifyWrites()).toHaveLength(1);
    expect(notifyWrites()[0].data.lastNotifyStatus).toBe("SUPERSEDED");
  });

  it("records FAILED without a revert for a job enqueued before the claim travelled", async () => {
    findUnique.mockResolvedValue(null);
    const { sendAlertNotification } = await importModule();
    await sendAlertNotification(job);

    expect(stateWrites()).toHaveLength(0);
    expect(notifyWrites()[0].data.lastNotifyStatus).toBe("FAILED");
    // With no emission there is no instant to hold it behind.
    expect(notifyWrites()[0].where).toEqual({ id: "al_1" });
  });

  it("does not give the page back on a failure the retry may still deliver", async () => {
    // The rule must keep believing it paged while attempts remain: reverting
    // here and delivering later pages a transition the row no longer records.
    postMessage.mockRejectedValue(slackHttpError(503));
    const { sendAlertNotification } = await importModule();

    await expect(sendAlertNotification(compensableJob)).rejects.toMatchObject({ statusCode: 503 });
    expect(stateWrites()).toHaveLength(0);
    expect(notifyWrites()).toHaveLength(0);
  });

  it("does not let a failed bookkeeping write fail a job that already sent", async () => {
    alertUpdateMany.mockRejectedValue(new Error("pool timeout"));
    const { sendAlertNotification } = await importModule();

    await expect(sendAlertNotification(compensableJob)).resolves.toBeUndefined();
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});

describe("startAlertNotificationWorker", () => {
  it("consumes the alert-notification queue and delegates each job to the sender", async () => {
    const { startAlertNotificationWorker } = await importModule();
    startAlertNotificationWorker();

    const [name, processor, opts] = workerConstructed.mock.calls[0];
    expect(name).toBe("alert-notification");
    expect(opts).toMatchObject({ concurrency: 5 });
    expect(opts.settings.backoffStrategy(3)).toBe(3000);

    await processor({ data: job });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  // The second row judges exhaustion by the budget the job was given rather
  // than by whatever today's constant happens to be.
  it.each([
    [12, 12],
    [5, 5],
  ])("gives the page back once attempt %i of %i spends the job's budget", async (made, of) => {
    const { startAlertNotificationWorker } = await importModule();
    startAlertNotificationWorker();

    workerHandlers.get("failed")?.(
      { id: "j1", attemptsMade: made, opts: { attempts: of }, data: compensableJob },
      new Error("rate limited"),
    );
    await vi.waitFor(() => expect(notifyWrites()).toHaveLength(1));

    expect(notifyWrites()[0].data.lastNotifyStatus).toBe("COMPENSATED");
    expect(notifyWrites()[0].data.lastNotifyError).toBe("retries-exhausted");
  });

  it("leaves a replay whose attempts ran out due again, as the severity it announced", async () => {
    // The replay of a page Slack never received: the rule already read ALERT on the
    // failed page's stamp, so that is the prior state the replay's emission carries.
    const pagedAt = emission.evaluatedAt - 60 * 60_000;
    const replay = {
      ...job,
      previousSeverity: "ALERT" as const,
      emission: {
        evaluatedAt: emission.evaluatedAt,
        priorSeverity: "ALERT" as const,
        priorSeverityChangedAt: pagedAt,
        priorAlertedAt: pagedAt,
      },
    };
    const stored: Record<string, unknown> = alertRow({ severityChangedAt: new Date(pagedAt) });
    alertUpdateMany.mockImplementation(async ({ where, data }) => {
      const matches = Object.entries(where).every(([field, expected]) => {
        const actual = stored[field];
        return expected instanceof Date && actual instanceof Date
          ? expected.getTime() === actual.getTime()
          : expected === actual;
      });
      if (matches) Object.assign(stored, data);
      return { count: matches ? 1 : 0 };
    });

    const { startAlertNotificationWorker } = await importModule();
    const { applyAlertStateMachine } = await import("../../alerts/severity-state-machine.js");
    const { parseAlertRule } = await import("../../alerts/rule.js");
    const { isAwaitingRedelivery } = await import("../../alerts/delivery.js");
    startAlertNotificationWorker();

    workerHandlers.get("failed")?.(
      { id: "j-replay", attemptsMade: 12, opts: { attempts: 12 }, data: replay },
      new Error("service_unavailable"),
    );
    await vi.waitFor(() => expect(stored.lastNotifyStatus).toBe("COMPENSATED"));

    expect(stored).toMatchObject({
      severity: "ALERT",
      alertedAt: new Date(pagedAt),
      lastNotifyError: "retries-exhausted",
      lastNotifySeverity: "ALERT",
    });
    const state = {
      severity: "ALERT" as const,
      severityChangedAt: stored.severityChangedAt as Date,
      alertedAt: stored.alertedAt as Date,
    };
    // A breach the state machine reads as already paged: renotify off, nothing to say.
    expect(
      applyAlertStateMachine(state, "ALERT", new Date(emission.evaluatedAt + 60_000), {
        mode: "OFF",
      }).emit,
    ).toBe(false);
    // Which is what leaves the redelivery to say it.
    const rule = parseAlertRule({
      id: "al_1",
      projectId: "proj_1",
      name: job.name,
      view: "SPANS",
      measure: job.measure,
      aggregation: job.aggregation,
      filters: [],
      window: job.window,
      thresholdOperator: job.thresholdOperator,
      threshold: job.threshold,
      renotify: { mode: "OFF" },
      noDataMode: "HOLD",
      ...state,
      lastNotifyStatus: stored.lastNotifyStatus as string,
      lastNotifyError: stored.lastNotifyError as string,
      lastNotifyAt: stored.lastNotifyAt as Date,
      lastNotifySeverity: stored.lastNotifySeverity as string,
      slackUpdatedAt: null,
    });
    expect(rule).not.toBeNull();
    expect(isAwaitingRedelivery(rule!, "ALERT")).toBe(true);
  });

  it("hands a close job to the close sender, not to the page sender", async () => {
    const { startAlertNotificationWorker } = await importModule();
    startAlertNotificationWorker();

    const [, processor] = workerConstructed.mock.calls[0];
    await processor({ data: closeJob, updateData: vi.fn() });

    expect(buildAlertClosedBlocks).toHaveBeenCalledTimes(1);
    expect(buildAlertBlocks).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("puts a close back on the rule once its attempts run out, touching no delivery record", async () => {
    const { startAlertNotificationWorker } = await importModule();
    startAlertNotificationWorker();

    workerHandlers.get("failed")?.(
      { id: "j1", attemptsMade: 12, opts: { attempts: 12 }, data: closeJob },
      new Error("rate limited"),
    );
    await vi.waitFor(() => expect(closeRestores()).toHaveLength(1));

    expect(closeRestores()[0].data.pendingClose).toEqual(closeMarker);
    expect(notifyWrites()).toHaveLength(0);
    expect(stateWrites()).toHaveLength(0);
  });

  it("puts a carried close back too when the page it rode on runs out of attempts", async () => {
    const { startAlertNotificationWorker } = await importModule();
    startAlertNotificationWorker();

    workerHandlers.get("failed")?.(
      {
        id: "j1",
        attemptsMade: 12,
        opts: { attempts: 12 },
        data: { ...compensableJob, closeFirst: closeMarker },
      },
      new Error("rate limited"),
    );
    await vi.waitFor(() => expect(notifyWrites()).toHaveLength(1));

    // The page is rolled back for the next tick to raise again, and the close
    // goes back with it so that tick sends the pair in order once more.
    expect(notifyWrites()[0].data.lastNotifyStatus).toBe("COMPENSATED");
    expect(closeRestores()).toHaveLength(1);
    expect(closeRestores()[0].data.pendingClose).toEqual(closeMarker);
  });

  it("leaves a job with attempts left alone, and logs the attempt as a retry", async () => {
    const { startAlertNotificationWorker } = await importModule();
    startAlertNotificationWorker();

    workerHandlers.get("failed")?.(
      { id: "j1", attemptsMade: 3, opts: { attempts: 12 }, data: compensableJob },
      new Error("rate limited"),
    );

    expect(alertUpdateMany).not.toHaveBeenCalled();
    const line = logError.mock.calls[0][0] as string;
    expect(line).toContain("j1");
    expect(line).toContain("attempt 3");
    expect(line).toContain("rate limited");
  });
});

describe("enqueueAlertClose", () => {
  it("marks the job as a close and gives every call a job id of its own", async () => {
    vi.useFakeTimers();
    try {
      const { enqueueAlertClose } = await importModule();
      const { kind: _kind, ...close } = closeJob;

      vi.setSystemTime(new Date("2026-06-23T12:32:00.000Z"));
      await enqueueAlertClose(close);
      vi.setSystemTime(new Date("2026-06-23T13:05:00.000Z"));
      await enqueueAlertClose(close);

      const [name, payload, options] = queueAdd.mock.calls[0];
      expect(payload).toEqual(closeJob);
      expect(options.jobId).toBe(name);
      // BullMQ dedupes against finished jobs too, so a close put back after
      // reaching nobody must not be swallowed by the id of its first attempt.
      expect(queueAdd.mock.calls[1][2].jobId).not.toBe(options.jobId);
      // Nor may it collide with the page the same tick enqueues for the rule.
      expect(name).toMatch(/^alert-close-al_1-/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sendAlertClose", () => {
  it("posts the built close, naming who made the change, and records no delivery", async () => {
    const { sendAlertClose } = await importModule();
    await sendAlertClose(closeJob);

    expect(buildAlertClosedBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_1",
        alertId: "al_1",
        name: "Checkout p95 latency",
        reason: "edited",
        actor: "Ada",
      }),
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C_WORKSPACE", text: "[OK] rule", unfurl_links: false }),
    );
    // `lastNotify*` reports on the page the rule stands on, which a redelivery
    // reads; a close is about the page before it.
    expect(alertUpdateMany).not.toHaveBeenCalled();
  });

  it("names nobody for an account with no name, or one that is gone, and never reads an email", async () => {
    const { sendAlertClose } = await importModule();

    userFindUnique.mockResolvedValueOnce({ name: "" });
    await sendAlertClose(closeJob);
    userFindUnique.mockResolvedValueOnce(null);
    await sendAlertClose(closeJob);

    const actors = buildAlertClosedBlocks.mock.calls.map(
      ([params]) => (params as { actor: unknown }).actor,
    );
    expect(actors).toEqual([null, null]);
    // The channel's readers need not have access to the project, so the address
    // the app would fall back to is not even selected.
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { id: "user_1" },
      select: { name: true },
    });
  });

  it("posts the close of a paused rule: pausing does not undo the discard", async () => {
    alertFindUnique.mockResolvedValue(alertRow({ status: "PAUSED" }));
    const { sendAlertClose } = await importModule();
    await sendAlertClose(closeJob);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(alertUpdateMany).not.toHaveBeenCalled();
  });

  it("drops the close of a deleted rule, which has no page left to close", async () => {
    alertFindUnique.mockResolvedValue(null);
    const { sendAlertClose } = await importModule();
    await sendAlertClose(closeJob);

    expect(postMessage).not.toHaveBeenCalled();
    expect(alertUpdateMany).not.toHaveBeenCalled();
  });

  it("drops rather than loops on a channel no retry can reach", async () => {
    const { sendAlertClose } = await importModule();

    findUnique.mockResolvedValue(noChannelRow);
    await sendAlertClose(closeJob);
    findUnique.mockResolvedValue(projectRow());
    slackRefuses();
    await sendAlertClose(closeJob);

    expect(alertUpdateMany).not.toHaveBeenCalled();
  });

  it("rethrows a failure a retry may still deliver, leaving the marker to the retry budget", async () => {
    postMessage.mockRejectedValue(slackHttpError(503));
    const { sendAlertClose } = await importModule();

    await expect(sendAlertClose(closeJob)).rejects.toMatchObject({ statusCode: 503 });
    expect(alertUpdateMany).not.toHaveBeenCalled();
  });
});

describe("processAlertJob", () => {
  const pageWithClose = { ...compensableJob, closeFirst: closeMarker };
  const posted = () =>
    postMessage.mock.calls.map(([message]) => (message as { text: string }).text);

  it("posts the carried close before the page, and drops it from the job once posted", async () => {
    const updateData = vi.fn().mockResolvedValue(undefined);
    const { processAlertJob } = await importModule();
    await processAlertJob({ data: pageWithClose, updateData });

    expect(posted()).toEqual(["[OK] rule", "[ALERT] rule"]);
    expect(buildAlertClosedBlocks).toHaveBeenCalledWith(
      expect.objectContaining({ alertId: "al_1", name: job.name, reason: "edited" }),
    );
    // A retry of the page alone must not post the close a second time.
    expect(updateData).toHaveBeenCalledWith(compensableJob);
  });

  it("does not try the page while the close is still failing, so a retry keeps the order", async () => {
    postMessage.mockRejectedValueOnce(slackHttpError(503));
    const updateData = vi.fn();
    const { processAlertJob } = await importModule();

    await expect(processAlertJob({ data: pageWithClose, updateData })).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(buildAlertBlocks).not.toHaveBeenCalled();
    expect(updateData).not.toHaveBeenCalled();
  });

  it("still pages when the close is one no retry can deliver", async () => {
    postMessage.mockRejectedValueOnce(slackPlatformError("invalid_blocks"));
    const { processAlertJob } = await importModule();
    await processAlertJob({ data: pageWithClose, updateData: vi.fn() });

    expect(posted()).toEqual(["[OK] rule", "[ALERT] rule"]);
    expect(notifyWrites()[0].data.lastNotifyStatus).toBe("DELIVERED");
  });

  it("pages even when the posted close cannot be cleared from the job", async () => {
    const updateData = vi.fn().mockRejectedValue(new Error("redis down"));
    const { processAlertJob } = await importModule();
    await processAlertJob({ data: pageWithClose, updateData });

    expect(posted()).toEqual(["[OK] rule", "[ALERT] rule"]);
  });

  it("sends a page that carries no close, and a close sent alone, as before", async () => {
    const updateData = vi.fn();
    const { processAlertJob } = await importModule();

    await processAlertJob({ data: compensableJob, updateData });
    await processAlertJob({ data: closeJob, updateData });

    expect(posted()).toEqual(["[ALERT] rule", "[OK] rule"]);
    expect(updateData).not.toHaveBeenCalled();
  });
});
