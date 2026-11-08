import { describe, expect, it, vi } from "vitest";
import type { UpdateResult } from "@traceroot/core/updates";
import { deliverRun, type DeliveryDeps, type DeliveryRun, type SlackPoster } from "../deliver.js";
import type { RenderContext } from "../render.js";

const ctx: RenderContext = {
  appBaseUrl: "http://app",
  projectId: "p1",
  projectName: "P",
  windowStart: new Date("2026-10-26T09:00:00Z"),
  windowEnd: new Date("2026-11-02T09:00:00Z"),
  frequency: "weekly",
};
const link = { kind: "trace" as const, label: "t", url: "http://app/projects/p1/traces?traceId=a" };
const manyItems = Array.from({ length: 20 }, (_, i) => ({ text: `item ${i}`, evidence: [link] }));
const result: UpdateResult = {
  nothingToReport: false,
  headline: "Errors rose from 3 to 12.",
  summary: "s",
  sections: [
    { id: "shifts", title: "A", items: manyItems },
    { id: "signals", title: "B", items: manyItems },
    { id: "cost", title: "C", items: manyItems },
  ],
  suggestedDetectors: [],
  notesForNextRun: "",
};

function setup(overrides: Partial<DeliveryDeps> = {}) {
  const row: DeliveryRun & Record<string, unknown> = {
    id: "r1",
    projectId: "p1",
    slackDeliveredAt: null,
    slackMessageTs: null,
    slackThreadPosts: 0,
    emailDeliveredAt: null,
  };
  const calls = { headline: 0, thread: 0, email: 0 };
  const failThreadAt = { at: -1 };
  const poster: SlackPoster = {
    postHeadline: vi.fn(async () => {
      calls.headline += 1;
      return "1700000000.000100";
    }),
    postInThread: vi.fn(async () => {
      if (calls.thread === failThreadAt.at) {
        failThreadAt.at = -1;
        throw new Error("slack down");
      }
      calls.thread += 1;
    }),
  };
  const emailFails = { value: false };
  const deps: DeliveryDeps = {
    db: {
      projectUpdateRun: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(row, data);
          return row;
        }),
      },
    } as never,
    resolveRecipients: async () => ({
      workspaceId: "w1",
      slackChannelId: "C1",
      encryptedBotToken: "enc",
      emailAddresses: ["a@example.com"],
    }),
    slackFor: async () => poster,
    sendEmail: vi.fn(async () => {
      if (emailFails.value) {
        emailFails.value = false;
        throw new Error("smtp down");
      }
      calls.email += 1;
      return true;
    }),
    log: () => undefined,
    ...overrides,
  };
  return { row, calls, deps, failThreadAt, emailFails, poster };
}

describe("deliverRun", () => {
  it("sends the headline, the thread and the email once each", async () => {
    const { row, calls, deps } = setup();
    const outcome = await deliverRun(deps, row, result, ctx);
    expect(outcome).toMatchObject({ complete: true, slack: "sent", email: "sent" });
    expect(calls.headline).toBe(1);
    expect(calls.thread).toBeGreaterThan(0);
    expect(calls.email).toBe(1);
    expect(row.slackDeliveredAt).toBeInstanceOf(Date);
    expect(row.emailDeliveredAt).toBeInstanceOf(Date);
  });

  it("a failed email is retried without sending to Slack again (E2)", async () => {
    const { row, calls, deps, emailFails } = setup();
    emailFails.value = true;
    await expect(deliverRun(deps, row, result, ctx)).rejects.toThrow("smtp down");
    const slackAfterFirst = { headline: calls.headline, thread: calls.thread };
    expect(row.slackDeliveredAt).toBeInstanceOf(Date);

    const second = await deliverRun(deps, row, result, ctx);
    expect(second).toMatchObject({ slack: "already", email: "sent" });
    expect(calls.headline).toBe(slackAfterFirst.headline);
    expect(calls.thread).toBe(slackAfterFirst.thread);
    expect(calls.email).toBe(1);
  });

  it("a thread that failed part way continues where it stopped", async () => {
    const { row, calls, deps, failThreadAt } = setup();
    failThreadAt.at = 1;
    await expect(deliverRun(deps, row, result, ctx)).rejects.toThrow("slack down");
    expect(calls.headline).toBe(1);
    expect(calls.thread).toBe(1);
    expect(row.slackThreadPosts).toBe(1);

    await deliverRun(deps, row, result, ctx);
    expect(calls.headline).toBe(1);
    const total = calls.thread;
    // Every thread post exactly once: the count equals the number of posts the result needs.
    const again = await deliverRun(deps, row, result, ctx);
    expect(again).toMatchObject({ slack: "already", email: "already" });
    expect(calls.thread).toBe(total);
    expect(calls.email).toBe(1);
  });

  it("skips email with a clear note when no mail transport is configured, and still sends Slack (E5)", async () => {
    const { row, calls, deps } = setup({ sendEmail: async () => false });
    const outcome = await deliverRun(deps, row, result, ctx);
    expect(outcome.slack).toBe("sent");
    expect(outcome.email).toBe("skipped");
    expect(outcome.notes.join(" ")).toContain("TRACEROOT_SMTP_URL");
    expect(calls.headline).toBe(1);
    expect(row.emailDeliveredAt).toBeNull();
  });

  it("sends only email when the project has no Slack channel", async () => {
    const { row, calls, deps } = setup({
      resolveRecipients: async () => ({
        workspaceId: "w1",
        slackChannelId: null,
        encryptedBotToken: null,
        emailAddresses: ["a@example.com"],
      }),
    });
    const outcome = await deliverRun(deps, row, result, ctx);
    expect(outcome).toMatchObject({ slack: "skipped", email: "sent" });
    expect(calls.headline).toBe(0);
  });

  it("says so when there is nowhere to deliver", async () => {
    const { row, deps } = setup({ resolveRecipients: async () => null });
    const outcome = await deliverRun(deps, row, result, ctx);
    expect(outcome.complete).toBe(true);
    expect(outcome.notes.join(" ")).toContain("No Slack channel or email");
  });

  it("skips Slack with a note when the plan has no Slack integration", async () => {
    const { row, deps } = setup({ slackFor: async () => null });
    const outcome = await deliverRun(deps, row, result, ctx);
    expect(outcome.slack).toBe("skipped");
    expect(outcome.notes.join(" ")).toContain("plan");
  });
});
