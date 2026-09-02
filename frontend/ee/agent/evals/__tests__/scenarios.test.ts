import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DISPLAY_TYPES, FAKE_PROJECT_ID, SCENARIOS } from "../scenarios.js";
import type {
  DashboardRow,
  DetectorRow,
  EvalPrisma,
  ScenarioContext,
  TurnTranscript,
  WidgetRow,
} from "../types.js";

function scenarioNamed(name: string) {
  const scenario = SCENARIOS.find((s) => s.name === name);
  if (!scenario) throw new Error(`no scenario named ${name}`);
  return scenario;
}

const CANON = "Analyze this trace for any of the following failure patterns:";

function turn(overrides: Partial<TurnTranscript> = {}): TurnTranscript {
  return {
    sessionId: "sess-1",
    message: "hi",
    toolCalls: [],
    toolResults: [],
    assistantText: "",
    events: [],
    ...overrides,
  };
}

const toolCall = (name: string, args: Record<string, unknown>) => ({
  toolCallId: `tc-${name}`,
  name,
  args,
});

const detector = (overrides: Partial<DetectorRow> = {}): DetectorRow => ({
  id: "d-1",
  name: "Failures",
  template: "failure",
  prompt: CANON,
  ...overrides,
});

const widget = (overrides: Partial<WidgetRow> = {}): WidgetRow => ({
  id: "w-1",
  dashboardId: "db-1",
  title: "Widget",
  type: "query",
  spec: {},
  ...overrides,
});

const dashboard = (overrides: Partial<DashboardRow> = {}): DashboardRow => ({
  id: "db-1",
  name: "Default",
  layout: [],
  widgets: [],
  ...overrides,
});

function makeCtx(overrides: Partial<ScenarioContext> = {}): ScenarioContext {
  return {
    fixture: {
      runId: "r1",
      user: { id: "u-1", email: "eval@example.com", workspaceId: "ws-1" },
      projectId: "proj-1",
      projectName: "agent-eval-r1",
    },
    turns: [],
    before: { detectors: [], dashboards: [] },
    after: { detectors: [], dashboards: [] },
    created: { detectors: [], dashboards: [], widgets: [] },
    probeWidgetQuery: async () => 200,
    canonicalPrompt: () => CANON,
    prisma: {
      dashboard: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as EvalPrisma,
    ...overrides,
  };
}

/**
 * Every scenario asserts by throwing; a resolved promise means "passed".
 * Async so a synchronous assert's throw surfaces as a rejection too.
 */
const run = async (name: string, ctx: ScenarioContext) => scenarioNamed(name).assert(ctx);

describe("the scenario suite", () => {
  it("covers the seven v1 behaviors", () => {
    expect(SCENARIOS.map((s) => s.name)).toEqual([
      "standard-detector",
      "custom-detector",
      "sparkline",
      "traces-by-model",
      "dashboard-compose",
      "idempotency",
      "tenancy",
    ]);
  });

  it("sends one user message per scenario, except the two deliberate pairs", () => {
    const pairs = new Set(["idempotency", "custom-detector"]);
    for (const scenario of SCENARIOS) {
      expect(scenario.messages).toHaveLength(pairs.has(scenario.name) ? 2 : 1);
    }
  });

  it("repeats the identical message in two sessions for the idempotency check", () => {
    const idempotency = scenarioNamed("idempotency");
    expect(idempotency.sessionPerMessage).toBe(true);
    expect(idempotency.messages[0]).toBe(idempotency.messages[1]);
  });

  it("mirrors the UI's display vocabulary, so the sparkline check cannot drift", () => {
    // The display list is owned by the dashboards feature in the Next app,
    // which this package does not depend on; parse it rather than import it.
    const source = readFileSync(
      fileURLToPath(new URL("../../../../ui/src/features/dashboards/types.ts", import.meta.url)),
      "utf8",
    );
    const block = source.match(/export const DISPLAY_TYPES = \[([^\]]+)\]/)?.[1];
    expect(block).toBeTruthy();

    const uiTypes = [...block!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect([...DISPLAY_TYPES]).toEqual(uiTypes);
  });
});

describe("standard-detector", () => {
  const passing = () =>
    makeCtx({
      turns: [
        turn({
          toolCalls: [toolCall("create_detector", { name: "Failures", template: "failure" })],
        }),
      ],
      created: { detectors: [detector()], dashboards: [], widgets: [] },
    });

  it("passes when the prompt was omitted and the canonical text was stored", async () => {
    await expect(run("standard-detector", passing())).resolves.toBeUndefined();
  });

  it("fails when the model supplied its own prompt", async () => {
    const ctx = passing();
    ctx.turns[0]!.toolCalls[0]!.args.prompt = "my own instructions";
    await expect(run("standard-detector", ctx)).rejects.toThrow(/prompt/i);
  });

  it("fails when the model picked a different template", async () => {
    const ctx = passing();
    ctx.turns[0]!.toolCalls[0]!.args.template = "safety";
    await expect(run("standard-detector", ctx)).rejects.toThrow(/failure/);
  });

  it("fails when the stored prompt is not the canonical template text", async () => {
    const ctx = passing();
    ctx.created.detectors = [detector({ prompt: "something the model wrote" })];
    await expect(run("standard-detector", ctx)).rejects.toThrow(/canonical/i);
  });

  it("fails when no detector was created at all", async () => {
    const ctx = passing();
    ctx.created.detectors = [];
    await expect(run("standard-detector", ctx)).rejects.toThrow(/detector/);
  });
});

describe("custom-detector", () => {
  const CUSTOM = "Flag only tool timeouts longer than 30 seconds.";
  // The agent asks first, then writes once the follow-up picks the prompt.
  const passing = () =>
    makeCtx({
      turns: [
        turn({ assistantText: "Do you want a judged prompt or a trigger on duration_ms?" }),
        turn({
          toolCalls: [
            toolCall("create_detector", {
              name: "Timeouts",
              template: "failure",
              prompt: CUSTOM,
            }),
          ],
        }),
      ],
      created: { detectors: [detector({ prompt: CUSTOM })], dashboards: [], widgets: [] },
    });

  it("follows the ambiguous ask up in the same session", () => {
    const scenario = scenarioNamed("custom-detector");
    expect(scenario.sessionPerMessage).toBeUndefined();
    expect(scenario.messages[1]).toContain("30 seconds");
  });

  it("reports an agent that only ever asked, quoting the question", async () => {
    const ctx = passing();
    ctx.turns = [ctx.turns[0]!];
    ctx.created.detectors = [];
    await expect(run("custom-detector", ctx)).rejects.toThrow(
      /answered without calling any write tool.*duration_ms/s,
    );
  });

  it("passes when the supplied prompt was stored verbatim", async () => {
    await expect(run("custom-detector", passing())).resolves.toBeUndefined();
  });

  it("fails when the model omitted the prompt the user asked for", async () => {
    const ctx = passing();
    delete ctx.turns[1]!.toolCalls[0]!.args.prompt;
    await expect(run("custom-detector", ctx)).rejects.toThrow(/prompt/i);
  });

  it("fails when the prompt drops the constraint the user gave", async () => {
    const ctx = passing();
    ctx.turns[1]!.toolCalls[0]!.args.prompt = "Flag tool timeouts.";
    ctx.created.detectors = [detector({ prompt: "Flag tool timeouts." })];
    await expect(run("custom-detector", ctx)).rejects.toThrow(/30/);
  });

  it("fails when the stored prompt differs from the supplied one", async () => {
    const ctx = passing();
    ctx.created.detectors = [detector({ prompt: `${CUSTOM} (rewritten)` })];
    await expect(run("custom-detector", ctx)).rejects.toThrow(/verbatim/i);
  });
});

describe("sparkline", () => {
  const passing = () =>
    makeCtx({
      turns: [
        turn({
          assistantText:
            "TraceRoot has no sparkline display, so I built the Token Watch dashboard with a line chart instead.",
        }),
      ],
      created: {
        detectors: [],
        dashboards: [dashboard({ id: "db-2", name: "Token Watch" })],
        widgets: [widget({ dashboardId: "db-2", spec: { display: { type: "line" } } })],
      },
    });

  it("passes when a legal display was used and the swap was disclosed", async () => {
    await expect(run("sparkline", passing())).resolves.toBeUndefined();
  });

  it("fails when the stored display type is not a real display", async () => {
    const ctx = passing();
    ctx.created.widgets = [widget({ spec: { display: { type: "sparkline" } } })];
    await expect(run("sparkline", ctx)).rejects.toThrow(/display/i);
  });

  it("fails when the answer never mentions the requested sparkline", async () => {
    const ctx = passing();
    ctx.turns[0]!.assistantText = "Created the Token Watch dashboard with a line chart.";
    await expect(run("sparkline", ctx)).rejects.toThrow(/sparkline/i);
  });

  it("fails when the answer claims a sparkline without naming the substitute", async () => {
    const ctx = passing();
    ctx.turns[0]!.assistantText = "Created a sparkline of total tokens on Token Watch.";
    await expect(run("sparkline", ctx)).rejects.toThrow(/substitut|disclos/i);
  });

  it("fails when the Token Watch dashboard was never created", async () => {
    const ctx = passing();
    ctx.created.dashboards = [];
    await expect(run("sparkline", ctx)).rejects.toThrow(/token watch/i);
  });
});

describe("traces-by-model", () => {
  const passing = () =>
    makeCtx({
      created: {
        detectors: [],
        dashboards: [],
        widgets: [
          widget({
            spec: {
              view: "spans",
              breakdown: "model_name",
              metric: { measure: "count", agg: "count" },
              display: { type: "bar" },
            },
          }),
        ],
      },
    });

  it("passes when the spec groups spans by model and the query runs", async () => {
    await expect(run("traces-by-model", passing())).resolves.toBeUndefined();
  });

  it("fails when the breakdown is not the model dimension", async () => {
    const ctx = passing();
    ctx.created.widgets = [widget({ spec: { view: "spans", breakdown: "environment" } })];
    await expect(run("traces-by-model", ctx)).rejects.toThrow(/model_name/);
  });

  it("fails when the spec queries the wrong view", async () => {
    const ctx = passing();
    ctx.created.widgets = [widget({ spec: { view: "traces", breakdown: "model_name" } })];
    await expect(run("traces-by-model", ctx)).rejects.toThrow(/spans/);
  });

  it("fails when the stored spec will not render", async () => {
    const ctx = passing();
    ctx.probeWidgetQuery = async () => 422;
    await expect(run("traces-by-model", ctx)).rejects.toThrow(/422/);
  });
});

describe("dashboard-compose", () => {
  const passing = () =>
    makeCtx({
      created: {
        detectors: [],
        dashboards: [
          dashboard({
            id: "db-2",
            name: "Latency overview",
            layout: [
              { i: "w-1", x: 0, y: 0, w: 6, h: 4 },
              { i: "w-2", x: 6, y: 0, w: 6, h: 4 },
            ],
            widgets: [],
          }),
        ],
        widgets: [
          widget({ id: "w-1", dashboardId: "db-2", spec: { view: "traces" } }),
          widget({ id: "w-2", dashboardId: "db-2", spec: { view: "traces" } }),
        ],
      },
    });

  it("passes when both widgets exist and each is placed in the grid", async () => {
    await expect(run("dashboard-compose", passing())).resolves.toBeUndefined();
  });

  it("fails when the named dashboard was not created", async () => {
    const ctx = passing();
    ctx.created.dashboards = [dashboard({ id: "db-2", name: "Something else" })];
    await expect(run("dashboard-compose", ctx)).rejects.toThrow(/latency overview/i);
  });

  it("fails when only one widget landed on it", async () => {
    const ctx = passing();
    ctx.created.widgets = [ctx.created.widgets[0]!];
    await expect(run("dashboard-compose", ctx)).rejects.toThrow(/2 widgets/);
  });

  it("fails when a widget has no grid placement", async () => {
    const ctx = passing();
    ctx.created.dashboards[0]!.layout = [{ i: "w-1", x: 0, y: 0, w: 6, h: 4 }];
    await expect(run("dashboard-compose", ctx)).rejects.toThrow(/w-2/);
  });

  it("fails when a stored spec will not render", async () => {
    const ctx = passing();
    ctx.probeWidgetQuery = async () => 422;
    await expect(run("dashboard-compose", ctx)).rejects.toThrow(/422/);
  });

  it("does not probe a trace-feed widget, which has no query spec", async () => {
    const ctx = passing();
    ctx.created.widgets[1] = widget({ id: "w-2", dashboardId: "db-2", type: "trace_feed" });
    const probe = vi.fn(async () => 200);
    ctx.probeWidgetQuery = probe;

    await expect(run("dashboard-compose", ctx)).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("idempotency", () => {
  const named = (name: string) => dashboard({ id: `db-${name}`, name });

  it("passes when the repeated request produced exactly one dashboard", async () => {
    const ctx = makeCtx({
      after: { detectors: [], dashboards: [named("Default"), named("Reliability overview")] },
    });
    await expect(run("idempotency", ctx)).resolves.toBeUndefined();
  });

  it("fails when the second turn created a duplicate", async () => {
    const ctx = makeCtx({
      after: {
        detectors: [],
        dashboards: [
          dashboard({ id: "a", name: "Reliability overview" }),
          dashboard({ id: "b", name: "Reliability overview" }),
        ],
      },
    });
    await expect(run("idempotency", ctx)).rejects.toThrow(/2/);
  });

  it("fails when neither turn created the dashboard", async () => {
    const ctx = makeCtx({ after: { detectors: [], dashboards: [named("Default")] } });
    await expect(run("idempotency", ctx)).rejects.toThrow(/reliability overview/i);
  });

  it("matches the name case- and whitespace-insensitively", async () => {
    const ctx = makeCtx({
      after: { detectors: [], dashboards: [dashboard({ name: "  reliability OVERVIEW " })] },
    });
    await expect(run("idempotency", ctx)).resolves.toBeUndefined();
  });
});

describe("tenancy", () => {
  it("names a project id that cannot exist in the message", () => {
    expect(scenarioNamed("tenancy").messages[0]).toContain(FAKE_PROJECT_ID);
  });

  it("passes when the tool refused the model's project id and nothing leaked", async () => {
    const ctx = makeCtx({
      turns: [turn({ toolCalls: [toolCall("create_widget", { dashboard_id: "db-1" })] })],
    });
    await expect(run("tenancy", ctx)).resolves.toBeUndefined();
  });

  it("passes when the model declined to call the tool at all", async () => {
    await expect(run("tenancy", makeCtx())).resolves.toBeUndefined();
  });

  it("fails when a model-supplied project id reached the tool", async () => {
    const ctx = makeCtx({
      turns: [
        turn({
          toolCalls: [toolCall("create_widget", { project_id: FAKE_PROJECT_ID })],
        }),
      ],
    });
    await expect(run("tenancy", ctx)).rejects.toThrow(/project_id/);
  });

  it("fails when rows landed under the named foreign project", async () => {
    const ctx = makeCtx({
      prisma: {
        dashboard: { findMany: vi.fn().mockResolvedValue([dashboard()]) },
      } as unknown as EvalPrisma,
    });
    await expect(run("tenancy", ctx)).rejects.toThrow(new RegExp(FAKE_PROJECT_ID));
  });

  it("checks the foreign project by id", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = makeCtx({ prisma: { dashboard: { findMany } } as unknown as EvalPrisma });

    await run("tenancy", ctx);

    expect(findMany).toHaveBeenCalledWith({ where: { projectId: FAKE_PROJECT_ID } });
  });
});
