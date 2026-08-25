/**
 * Alerts end to end: a rule stored the way the API stores it, spans in
 * ClickHouse, one scheduler tick evaluated by the real REST backend, the
 * severity it writes back, and the Slack message that comes out the other end.
 *
 * Only the Redis queue and the Slack client are stubbed (at the process
 * boundary): the queue so the job the tick enqueues can be handed straight to
 * the delivery worker, the client so the message can be asserted on — or, with
 * E2E_SLACK_BOT_TOKEN / E2E_SLACK_CHANNEL_ID set, posted to a real channel.
 *
 * Every scenario runs in its own tenant and ticks only that tenant's projects
 * (`runAlertTick`'s scope), so the suite neither touches nor sees any other
 * rule on the database it runs against.
 *
 * Needs the dev stack (`make dev`): see README.md in this directory.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectSlack,
  createRule,
  createTenant,
  deleteSpans,
  evaluatedWindow,
  instantsWithin,
  makeDue,
  preflight,
  readEnv,
  readRule,
  seedSpans,
  teardown,
  type Tenant,
} from "./harness.js";

// ---------------------------------------------------------------------------
// Process-boundary stubs. Declared with vi.mock, so they live in this file.
// ---------------------------------------------------------------------------

const boundary = vi.hoisted(() => ({
  queueAdd: vi.fn<(name: string, job: unknown, opts: unknown) => Promise<unknown>>(),
  postMessage: vi.fn<(args: unknown) => Promise<unknown>>(),
  realSlack: {
    token: process.env.E2E_SLACK_BOT_TOKEN || undefined,
    channelId: process.env.E2E_SLACK_CHANNEL_ID || undefined,
  },
}));

vi.mock("../../queues/alert-notification-queue.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../queues/alert-notification-queue.js")>();
  return {
    ...original,
    createRedisConnection: () => ({}),
    createAlertNotificationQueue: () => ({ add: boundary.queueAdd }),
  };
});

vi.mock("@traceroot/slack", async (importOriginal) => {
  const original = await importOriginal<typeof import("@traceroot/slack")>();
  return {
    ...original,
    createSlackClient: (token: string) => {
      if (boundary.realSlack.token) {
        // Real delivery: the message is also recorded so the assertions below
        // read the same payload that went out.
        const client = original.createSlackClient(token);
        const real = client.chat.postMessage.bind(client.chat);
        client.chat.postMessage = (async (args: unknown) => {
          boundary.postMessage(args);
          return real(args as Parameters<typeof real>[0]);
        }) as typeof client.chat.postMessage;
        return client;
      }
      return { chat: { postMessage: boundary.postMessage } };
    },
  };
});

import { runAlertTick } from "../scheduler.js";
import { sendAlertNotification } from "../../notifications/alert-slack.js";
import type { AlertNotificationJob } from "../../queues/alert-notification-queue.js";

// ---------------------------------------------------------------------------
// Helpers over the stubs
// ---------------------------------------------------------------------------

function enqueuedJobs(): AlertNotificationJob[] {
  return boundary.queueAdd.mock.calls.map(([, job]) => job as AlertNotificationJob);
}

function jobFor(alertId: string): AlertNotificationJob {
  const job = enqueuedJobs().find((candidate) => candidate.alertId === alertId);
  if (!job) throw new Error(`no notification was enqueued for ${alertId}`);
  return job;
}

interface PostedMessage {
  channel: string;
  text: string;
  attachments: { color: string; blocks: { type: string; text?: { text: string } }[] }[];
}

function postedMessages(): PostedMessage[] {
  return boundary.postMessage.mock.calls.map(([args]) => args as PostedMessage);
}

function lastMessage(): PostedMessage {
  const messages = postedMessages();
  if (messages.length === 0) throw new Error("nothing was posted to Slack");
  return messages[messages.length - 1];
}

function sectionTexts(message: PostedMessage): string[] {
  return message.attachments[0].blocks
    .filter((block) => block.type === "section")
    .map((block) => block.text?.text ?? "");
}

function tracesLink(message: PostedMessage): URL | null {
  const links = sectionTexts(message).find((text) => text.includes("|View "));
  const match = links?.match(/<([^|>]+)\|View traces>/);
  return match ? new URL(match[1]) : null;
}

/** A tick over this scenario's tenants only. */
function tick(now: Date, ...tenants: Tenant[]): Promise<void> {
  return runAlertTick(now, { projectIds: tenants.map((tenant) => tenant.projectId) });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const env = readEnv();
const slackChannel = boundary.realSlack.channelId ?? "C_E2E_CHANNEL";

describe("alerts pipeline", () => {
  // Fresh per scenario: a rule claimed by one scenario's tick is due again a
  // minute later, so a shared tenant would let it leak into a later scenario
  // that happens to cross the boundary.
  let tenant: Tenant;
  const extraTenants: Tenant[] = [];

  beforeAll(async () => {
    boundary.postMessage.mockResolvedValue({ ok: true });
    boundary.queueAdd.mockResolvedValue(undefined);
    await preflight(env);
  });

  beforeEach(async () => {
    boundary.queueAdd.mockClear();
    boundary.postMessage.mockClear();
    tenant = await createTenant("pipeline");
    await connectSlack(tenant, { channelId: slackChannel, botToken: boundary.realSlack.token });
  });

  afterEach(async () => {
    await teardown(env, tenant);
    for (const extra of extraTenants.splice(0)) await teardown(env, extra);
  });

  it("evaluates a filtered rule against real spans, pages on the breach, and delivers the filters", async () => {
    const alertId = await createRule(tenant, {
      name: "e2e agent span count",
      filters: [{ field: "span_kind", op: "=", value: "AGENT" }],
    });

    // Five AGENT spans and five SPAN spans in the evaluated window: the filter
    // decides the count, so the value the page carries proves it was applied.
    const now = new Date();
    const window = evaluatedWindow(now, "1m");
    await seedSpans(env, tenant.projectId, [
      ...instantsWithin(window, 5).map((start) => ({ start, spanKind: "AGENT" })),
      ...instantsWithin(window, 5).map((start) => ({ start, spanKind: "SPAN" })),
    ]);

    await tick(now, tenant);

    const rule = await readRule(alertId);
    expect(rule.severity).toBe("ALERT");
    expect(rule.lastError).toBeNull();
    expect(rule.lastEvaluatedAt?.getTime()).toBe(window.boundary.getTime());

    const job = jobFor(alertId);
    expect(job).toMatchObject({
      projectId: tenant.projectId,
      severity: "ALERT",
      previousSeverity: "UNKNOWN",
      value: 5,
      threshold: 1,
      filters: [{ field: "span_kind", op: "=", value: "AGENT" }],
    });
    expect(job.windowEnd).toBe(window.end.getTime());

    // The delivery worker, fed the job the tick enqueued.
    await sendAlertNotification(job);

    const message = lastMessage();
    expect(message.channel).toBe(slackChannel);
    expect(message.text).toContain("[ALERT] e2e agent span count");
    expect(message.text).toContain("Where `span_kind = AGENT`.");
    const [outcome] = sectionTexts(message);
    expect(outcome).toContain("`count` was 5, above the 1 threshold, over the last 1m.");
    expect(outcome).toContain("Where `span_kind = AGENT`.");

    const link = tracesLink(message);
    expect(link).not.toBeNull();
    expect(link!.pathname).toBe(`/projects/${tenant.projectId}/traces`);
    expect(link!.searchParams.get("date_filter")).toBe("custom");
    expect(link!.searchParams.get("start")).toBe(window.start.toISOString());
    expect(link!.searchParams.get("end")).toBe(window.end.toISOString());
    expect(JSON.parse(link!.searchParams.get("filters")!)).toEqual([
      { field: "span_kind", op: "in", value: ["AGENT"] },
    ]);

    const delivered = await readRule(alertId);
    expect(delivered.lastNotifyStatus).toBe("DELIVERED");
    expect(delivered.lastNotifyError).toBeNull();
    expect(delivered.lastNotifyAt).not.toBeNull();
  });

  it("recovers to OK on an empty window for a count rule, and the recovery carries no traces link", async () => {
    const alertId = await createRule(tenant, { name: "e2e recovery" });
    const first = new Date();
    await seedSpans(
      env,
      tenant.projectId,
      instantsWithin(evaluatedWindow(first), 3).map((start) => ({ start })),
    );
    await tick(first, tenant);
    expect((await readRule(alertId)).severity).toBe("ALERT");
    boundary.queueAdd.mockClear();

    // An empty window counts as zero for `count`, so the rule recovers rather
    // than holding (HOLD applies to measures with no value, not to a zero).
    await deleteSpans(env, tenant.projectId);
    await makeDue(alertId);
    await tick(new Date(), tenant);

    expect((await readRule(alertId)).severity).toBe("OK");
    const job = jobFor(alertId);
    expect(job).toMatchObject({ severity: "OK", previousSeverity: "ALERT" });

    await sendAlertNotification(job);
    const message = lastMessage();
    expect(message.text).toContain("[OK] e2e recovery");
    expect(sectionTexts(message)[0]).toContain("recovered to 0");
    expect(tracesLink(message)).toBeNull();
    expect(sectionTexts(message).join(" ")).toContain("|View alert>");
  });

  it("keeps a filter the trace list cannot express in the prose, out of the link", async () => {
    const alertId = await createRule(tenant, {
      name: "e2e contains filter",
      filters: [{ field: "name", op: "contains", value: "e2e" }],
    });
    const now = new Date();
    await seedSpans(
      env,
      tenant.projectId,
      instantsWithin(evaluatedWindow(now), 3).map((start) => ({ start })),
    );
    await tick(now, tenant);
    expect((await readRule(alertId)).severity).toBe("ALERT");

    await sendAlertNotification(jobFor(alertId));
    const message = lastMessage();
    expect(sectionTexts(message)[0]).toContain("Where `name contains e2e`.");
    const link = tracesLink(message);
    expect(link).not.toBeNull();
    expect(link!.searchParams.has("filters")).toBe(false);
  });

  it("filters on a metadata key end to end: the count, the prose and the keyed link predicate", async () => {
    const alertId = await createRule(tenant, {
      name: "e2e acme spans",
      filters: [{ field: "metadata", key: "tenant", op: "=", value: "acme" }],
    });
    const now = new Date();
    const window = evaluatedWindow(now);
    // The map ClickHouse materializes from the metadata JSON is what the
    // evaluator filters on, so the seed writes the JSON and nothing else.
    await seedSpans(env, tenant.projectId, [
      ...instantsWithin(window, 4).map((start) => ({ start, metadata: { tenant: "acme" } })),
      ...instantsWithin(window, 3).map((start) => ({ start, metadata: { tenant: "other" } })),
      ...instantsWithin(window, 2).map((start) => ({ start })),
    ]);
    await tick(now, tenant);

    expect((await readRule(alertId)).severity).toBe("ALERT");
    const job = jobFor(alertId);
    expect(job.value).toBe(4);

    await sendAlertNotification(job);
    const message = lastMessage();
    expect(sectionTexts(message)[0]).toContain("Where `metadata[tenant] = acme`.");
    expect(JSON.parse(tracesLink(message)!.searchParams.get("filters")!)).toEqual([
      { field: "metadata", key: "tenant", op: "eq", value: "acme" },
    ]);
  });

  it("measures p95 latency over real durations, then shows NO_DATA without paging under HOLD", async () => {
    const alertId = await createRule(tenant, {
      name: "e2e p95 latency",
      measure: "latency",
      aggregation: "p95",
      threshold: 500,
      noDataMode: "HOLD",
    });
    const now = new Date();
    const window = evaluatedWindow(now);
    // Durations 100ms..1000ms: the p95 sits in the top decile, well over 500.
    await seedSpans(
      env,
      tenant.projectId,
      instantsWithin(window, 10).map((start, i) => ({ start, durationMs: (i + 1) * 100 })),
    );
    await tick(now, tenant);

    const breached = await readRule(alertId);
    expect(breached.severity).toBe("ALERT");
    const job = jobFor(alertId);
    expect(job.value).toBeGreaterThan(500);
    expect(job.value).toBeLessThanOrEqual(1000);

    await sendAlertNotification(job);
    const [outcome] = sectionTexts(lastMessage());
    expect(outcome).toMatch(/`p95\(latency\)` was \d+(\.\d+)?ms, above the 500ms threshold/);

    // No rows, so p95 has no value (unlike count's honest zero). Under HOLD the
    // gap shows as NO_DATA on the rule but is not the incident: nothing pages,
    // and the breach's clocks are kept so the return to data is judged
    // against the ALERT it interrupted.
    boundary.queueAdd.mockClear();
    await deleteSpans(env, tenant.projectId);
    await makeDue(alertId);
    await tick(new Date(), tenant);

    const held = await readRule(alertId);
    expect(held.severity).toBe("NO_DATA");
    expect(held.lastError).toBeNull();
    expect(held.alertedAt?.getTime()).toBe(breached.alertedAt?.getTime());
    expect(enqueuedJobs()).toEqual([]);
  });

  it("pages NO_DATA on an empty window under NOTIFY, and pages the return to data", async () => {
    const alertId = await createRule(tenant, {
      name: "e2e silent source",
      measure: "latency",
      aggregation: "avg",
      threshold: 10_000,
      noDataMode: "NOTIFY",
    });

    // A window with nothing in it is the incident for this mode.
    await tick(new Date(), tenant);
    expect((await readRule(alertId)).severity).toBe("NO_DATA");
    const silence = jobFor(alertId);
    expect(silence).toMatchObject({
      severity: "NO_DATA",
      previousSeverity: "UNKNOWN",
      value: null,
    });
    await sendAlertNotification(silence);
    const silenceMessage = lastMessage();
    expect(silenceMessage.text).toContain("[NO_DATA] e2e silent source");
    expect(sectionTexts(silenceMessage)[0]).toContain("No data for `avg(latency)`");
    expect(tracesLink(silenceMessage)).toBeNull();

    // Data returns, within threshold: that is a transition worth a page too.
    boundary.queueAdd.mockClear();
    const now = new Date();
    await seedSpans(
      env,
      tenant.projectId,
      instantsWithin(evaluatedWindow(now), 3).map((start) => ({ start, durationMs: 100 })),
    );
    await makeDue(alertId);
    await tick(now, tenant);

    expect((await readRule(alertId)).severity).toBe("OK");
    const recovery = jobFor(alertId);
    expect(recovery).toMatchObject({ severity: "OK", previousSeverity: "NO_DATA" });
    await sendAlertNotification(recovery);
    const recoveryMessage = lastMessage();
    expect(recoveryMessage.text).toContain("[OK] e2e silent source");
    expect(sectionTexts(recoveryMessage)[0]).toMatch(/`avg\(latency\)` recovered to \d+/);
    expect((await readRule(alertId)).lastNotifyStatus).toBe("DELIVERED");
  });

  it("sums cost over the window and compares it with the stored operator", async () => {
    const alertId = await createRule(tenant, {
      name: "e2e spend",
      measure: "cost",
      aggregation: "sum",
      thresholdOperator: ">=",
      threshold: 1,
    });
    const now = new Date();
    await seedSpans(
      env,
      tenant.projectId,
      instantsWithin(evaluatedWindow(now), 4).map((start) => ({ start, cost: 0.25 })),
    );
    await tick(now, tenant);

    expect((await readRule(alertId)).severity).toBe("ALERT");
    const job = jobFor(alertId);
    expect(job.value).toBeCloseTo(1, 6);
    await sendAlertNotification(job);
    expect(sectionTexts(lastMessage())[0]).toContain(
      "`sum(cost)` was 1, at or above the 1 threshold, over the last 1m.",
    );
  });

  it("evaluates several rules across projects in one tick, each against its own project's spans", async () => {
    const other = await createTenant("neighbour");
    extraTenants.push(other);
    await connectSlack(other, { channelId: slackChannel, botToken: boundary.realSlack.token });

    // Same window, same measure: only the project decides what each rule sees.
    const busy = await createRule(tenant, { name: "e2e busy" });
    const busyTwice = await createRule(tenant, { name: "e2e busy again", threshold: 10 });
    const quiet = await createRule(other, { name: "e2e quiet" });

    const now = new Date();
    await seedSpans(
      env,
      tenant.projectId,
      instantsWithin(evaluatedWindow(now), 3).map((start) => ({ start })),
    );
    await tick(now, tenant, other);

    expect((await readRule(busy)).severity).toBe("ALERT");
    expect((await readRule(busyTwice)).severity).toBe("OK");
    expect((await readRule(quiet)).severity).toBe("OK");

    // One page, for the one rule that breached; the OK rules were never in
    // ALERT, so their first evaluation is not a transition worth a message.
    expect(enqueuedJobs().map((job) => job.alertId)).toEqual([busy]);
    expect(jobFor(busy)).toMatchObject({ projectId: tenant.projectId, value: 3 });
  });

  it("records a rule that breaches while the workspace has no Slack channel as FAILED / no-channel", async () => {
    const lonely = await createTenant("no-slack");
    extraTenants.push(lonely);
    const alertId = await createRule(lonely, { name: "e2e no channel" });
    const now = new Date();
    await seedSpans(
      env,
      lonely.projectId,
      instantsWithin(evaluatedWindow(now), 2).map((start) => ({ start })),
    );
    await tick(now, lonely);
    expect((await readRule(alertId)).severity).toBe("ALERT");

    await sendAlertNotification(jobFor(alertId));

    expect(boundary.postMessage).not.toHaveBeenCalled();
    const rule = await readRule(alertId);
    expect(rule.lastNotifyStatus).toBe("FAILED");
    expect(rule.lastNotifyError).toBe("no-channel");
    // The breach itself stands: a failed delivery is not an un-evaluation.
    expect(rule.severity).toBe("ALERT");
  });
});
