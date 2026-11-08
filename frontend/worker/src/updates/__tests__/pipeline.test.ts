import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { WindowAggregates } from "@traceroot/core/updates";
import { executeRun, type ExecuteDeps } from "../execute.js";

const agg = (traces: number, errors: number): WindowAggregates => ({
  start: "2026-10-26T09:00:00Z",
  end: "2026-11-02T09:00:00Z",
  totals: {
    traces,
    errorTraces: errors,
    p50Ms: 1000,
    p95Ms: 2000,
    p99Ms: 3000,
    gitContextTraces: 0,
  },
  llm: {
    calls: traces,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: traces * 100,
    cost: String(traces * 0.01),
  },
  byModel: [],
  byModelDay: [],
  tools: [],
  workflows: [{ name: "wf", traces, errorTraces: errors, p50Ms: 1000, p95Ms: 2000 }],
  refs: [],
  truncated: [],
});

const submit = (url: string): AssistantMessage => ({
  role: "assistant",
  content: [
    {
      type: "toolCall",
      id: "s1",
      name: "submit_update",
      arguments: {
        nothingToReport: false,
        headline: "wf errors rose from 30 to 120.",
        summary: "s",
        sections: [
          {
            id: "shifts",
            title: "Shifts",
            items: [{ text: "Errors rose.", evidence: [{ kind: "dashboard", label: "d", url }] }],
          },
        ],
        suggestedDetectors: [],
        notesForNextRun: "baseline: 1,000 traces",
      },
    },
  ],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "fake",
  usage: {
    input: 1200,
    output: 300,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1500,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
  },
  stopReason: "toolUse",
  timestamp: Date.now(),
});

function world(
  opts: {
    schedule?: Record<string, unknown> | null;
    priorCost?: number;
    current?: WindowAggregates;
    previous?: WindowAggregates;
  } = {},
) {
  const run: Record<string, unknown> = {
    id: "r1",
    projectId: "p1",
    status: "pending",
    timezone: "UTC",
    frequency: "weekly",
    attempts: 0,
    startedAt: null,
    createTime: new Date("2026-11-02T09:00:00Z"),
    windowStart: new Date("2026-10-26T09:00:00Z"),
    windowEnd: new Date("2026-11-02T09:00:00Z"),
    prevWindowStart: new Date("2026-10-19T09:00:00Z"),
    prevWindowEnd: new Date("2026-10-26T09:00:00Z"),
    slotAt: new Date("2026-11-02T09:00:00Z"),
    result: null,
    slackDeliveredAt: null,
    slackMessageTs: null,
    slackThreadPosts: 0,
    emailDeliveredAt: null,
  };
  const db = {
    projectUpdateRun: {
      updateMany: vi.fn(async ({ where }: { where: { OR?: unknown } }) => {
        if (!where.OR) return { count: 0 };
        if (run.status === "pending" || run.status === "failed") {
          run.status = "running";
          run.attempts = (run.attempts as number) + 1;
          return { count: 1 };
        }
        return { count: 0 };
      }),
      findUniqueOrThrow: vi.fn(async () => ({ ...run })),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        for (const [k, v] of Object.entries(data)) {
          run[k] =
            typeof v === "object" && v !== null && "increment" in (v as object)
              ? (run[k] as number) + (v as { increment: number }).increment
              : v;
        }
        return { ...run };
      }),
      aggregate: vi.fn(async () => ({ _sum: { costUsd: opts.priorCost ?? 0 } })),
    },
    projectUpdateSchedule: {
      findUnique: vi.fn(async () =>
        opts.schedule === undefined
          ? { runTokenCap: 200000, monthlySpendCapUsd: 20 }
          : opts.schedule,
      ),
    },
    project: {
      findFirst: vi.fn(async () => ({
        id: "p1",
        name: "P",
        workspaceId: "w1",
        rcaSource: null,
        rcaProvider: null,
        rcaModel: null,
      })),
    },
    signal: { findMany: vi.fn(async () => []) },
    signalHit: { groupBy: vi.fn(async () => []) },
    signalStatusEvent: { findMany: vi.fn(async () => []) },
  };
  const counts = { model: 0, slack: 0, thread: 0, email: 0 };
  const flaky = { email: false };
  const complete = vi.fn(async () => {
    counts.model += 1;
    return submit("http://app/projects/p1/dashboard");
  });
  const deps: ExecuteDeps = {
    db: db as never,
    readAggregates: async () => ({
      current: opts.current ?? agg(1000, 120),
      previous: opts.previous ?? agg(1000, 30),
    }),
    appBaseUrl: "http://app",
    agent: {
      resolveModel: async () => ({
        ok: true,
        model: { id: "fake" } as never,
        apiKey: "k",
        isByok: false,
      }),
      complete: complete as never,
      readSample: vi.fn(async () => []),
      runSql: vi.fn(async () => ({ columns: [], rows: [], truncated: false })),
      delivery: {
        db: db as never,
        resolveRecipients: async () => ({
          workspaceId: "w1",
          slackChannelId: "C1",
          encryptedBotToken: "t",
          emailAddresses: ["a@example.com"],
        }),
        slackFor: async () => ({
          postHeadline: async () => {
            counts.slack += 1;
            return "1.1";
          },
          postInThread: async () => {
            counts.thread += 1;
          },
        }),
        sendEmail: async () => {
          if (flaky.email) {
            flaky.email = false;
            throw new Error("smtp down");
          }
          counts.email += 1;
          return true;
        },
        log: () => undefined,
      },
    },
  };
  return { run, db, deps, counts, flaky, complete };
}

describe("a full run", () => {
  it("computes the facts, runs the agent, stores the result and delivers once", async () => {
    const w = world();
    const outcome = await executeRun(w.deps, "r1");
    expect(outcome.status).toBe("succeeded");
    expect(w.run.status).toBe("succeeded");
    expect((w.run.result as { headline: string }).headline).toContain("errors rose");
    expect(w.run.skillsRan).toContain("update-self-check");
    expect(w.run).toMatchObject({ tokensIn: 1200, tokensOut: 300, costUsd: 0.02, model: "fake" });
    expect(w.counts).toMatchObject({ model: 1, slack: 1, email: 1 });
  });

  it("retries after a failed email without a second model call or a second Slack message (E2)", async () => {
    const w = world();
    w.flaky.email = true;
    const first = await executeRun(w.deps, "r1");
    expect(first.status).toBe("failed");
    expect(w.run.status).toBe("failed");
    expect(w.run.error).toContain("smtp down");
    expect(w.counts).toMatchObject({ model: 1, slack: 1, email: 0 });

    const second = await executeRun(w.deps, "r1");
    expect(second.status).toBe("succeeded");
    expect(w.counts).toMatchObject({ model: 1, slack: 1, email: 1 });
    expect(w.run.attempts).toBe(2);
  });

  it("stops cleanly, with a visible reason, at a tiny token cap (E3)", async () => {
    const w = world({ schedule: { runTokenCap: 1000, monthlySpendCapUsd: 20 } });
    const outcome = await executeRun(w.deps, "r1");
    expect(outcome.status).toBe("stopped");
    expect(w.run).toMatchObject({ status: "stopped", stopReason: "token_cap", tokensIn: 1200 });
    expect(String(w.run.error)).toContain("token cap");
    expect(w.counts).toMatchObject({ slack: 0, email: 0 });
  });

  it("stops before asking a model when the project has used its monthly limit (E3)", async () => {
    const w = world({ schedule: { runTokenCap: 200000, monthlySpendCapUsd: 5 }, priorCost: 5.5 });
    const outcome = await executeRun(w.deps, "r1");
    expect(outcome.status).toBe("stopped");
    expect(w.run).toMatchObject({ status: "stopped", stopReason: "spend_limit" });
    expect(w.counts.model).toBe(0);
  });

  it("uses no model and sends nothing when there is nothing to report", async () => {
    const w = world({ current: agg(1000, 30), previous: agg(1000, 30) });
    const outcome = await executeRun(w.deps, "r1");
    expect(outcome.status).toBe("succeeded");
    expect(w.counts).toMatchObject({ model: 0, slack: 0, email: 0 });
    expect((w.run.result as { nothingToReport: boolean }).nothingToReport).toBe(true);
    expect(String(w.run.deliveryNote)).toContain("no message was sent");
  });

  it("fails visibly when no model key is configured", async () => {
    const w = world();
    (w.deps.agent as { resolveModel: unknown }).resolveModel = async () => ({
      ok: false,
      error: "No model API key is configured",
    });
    const outcome = await executeRun(w.deps, "r1");
    expect(outcome).toMatchObject({
      status: "failed",
      error: expect.stringContaining("No model API key"),
    });
    expect(w.run.status).toBe("failed");
  });

  it("only ever reads the project it is running for", async () => {
    const w = world();
    // The scripted model asks for the sample and a query before submitting.
    let turn = 0;
    (w.deps.agent as { complete: unknown }).complete = async () => {
      turn += 1;
      if (turn === 1) {
        const m = submit("http://app/projects/p1/dashboard");
        m.content = [
          { type: "toolCall", id: "a", name: "sample_traces", arguments: {} },
          {
            type: "toolCall",
            id: "b",
            name: "run_sql",
            arguments: { query: "SELECT 1", project_id: "other-tenant" },
          },
        ];
        return m;
      }
      return submit("http://app/projects/p1/dashboard");
    };
    await executeRun(w.deps, "r1");
    expect(w.deps.agent?.readSample).toHaveBeenCalledWith(
      "p1",
      expect.anything(),
      expect.any(Number),
    );
    expect(w.deps.agent?.runSql).toHaveBeenCalledWith("p1", "SELECT 1");
  });
});
