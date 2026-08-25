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
 * Needs the dev stack (`make dev`): see README.md in this directory.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

interface PostedMessage {
  channel: string;
  text: string;
  attachments: { color: string; blocks: { type: string; text?: { text: string } }[] }[];
}

function postedMessages(): PostedMessage[] {
  return boundary.postMessage.mock.calls.map(([args]) => args as PostedMessage);
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const env = readEnv();
const slackChannel = boundary.realSlack.channelId ?? "C_E2E_CHANNEL";

describe("alerts pipeline", () => {
  let tenant: Tenant;

  beforeAll(async () => {
    boundary.postMessage.mockResolvedValue({ ok: true });
    boundary.queueAdd.mockResolvedValue(undefined);
    await preflight(env);
    tenant = await createTenant("pipeline");
    await connectSlack(tenant, { channelId: slackChannel, botToken: boundary.realSlack.token });
  });

  afterAll(async () => {
    await teardown(env, tenant);
  });

  beforeEach(async () => {
    boundary.queueAdd.mockClear();
    boundary.postMessage.mockClear();
    await deleteSpans(env, tenant.projectId);
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

    await runAlertTick(now);

    const rule = await readRule(alertId);
    expect(rule.severity).toBe("ALERT");
    expect(rule.lastError).toBeNull();
    expect(rule.lastEvaluatedAt?.getTime()).toBe(window.boundary.getTime());

    const [job] = enqueuedJobs();
    expect(job).toMatchObject({
      alertId,
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

    const [message] = postedMessages();
    expect(message.channel).toBe(slackChannel);
    expect(message.text).toContain("[ALERT] e2e agent span count");
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
    await runAlertTick(first);
    expect((await readRule(alertId)).severity).toBe("ALERT");
    boundary.queueAdd.mockClear();

    // An empty window counts as zero for `count`, so the rule recovers rather
    // than holding (HOLD applies to measures with no value, not to a zero).
    await deleteSpans(env, tenant.projectId);
    await makeDue(alertId);
    await runAlertTick(new Date());

    expect((await readRule(alertId)).severity).toBe("OK");
    const [job] = enqueuedJobs();
    expect(job).toMatchObject({ alertId, severity: "OK", previousSeverity: "ALERT" });

    await sendAlertNotification(job);
    const [message] = postedMessages();
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
    await runAlertTick(now);
    expect((await readRule(alertId)).severity).toBe("ALERT");

    await sendAlertNotification(enqueuedJobs()[0]);
    const [message] = postedMessages();
    expect(sectionTexts(message)[0]).toContain("Where `name contains e2e`.");
    const link = tracesLink(message);
    expect(link).not.toBeNull();
    expect(link!.searchParams.has("filters")).toBe(false);
  });

  it("records a rule that breaches while the workspace has no Slack channel as FAILED / no-channel", async () => {
    const lonely = await createTenant("no-slack");
    try {
      const alertId = await createRule(lonely, { name: "e2e no channel" });
      const now = new Date();
      await seedSpans(
        env,
        lonely.projectId,
        instantsWithin(evaluatedWindow(now), 2).map((start) => ({ start })),
      );
      await runAlertTick(now);
      expect((await readRule(alertId)).severity).toBe("ALERT");

      const job = enqueuedJobs().find((candidate) => candidate.alertId === alertId);
      expect(job).toBeDefined();
      await sendAlertNotification(job!);

      expect(boundary.postMessage).not.toHaveBeenCalled();
      const rule = await readRule(alertId);
      expect(rule.lastNotifyStatus).toBe("FAILED");
      expect(rule.lastNotifyError).toBe("no-channel");
      // The breach itself stands: a failed delivery is not an un-evaluation.
      expect(rule.severity).toBe("ALERT");
    } finally {
      await teardown(env, lonely);
    }
  });
});
