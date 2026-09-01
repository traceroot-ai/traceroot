import {
  assistantText,
  expectThat,
  onlyCreated,
  onlyToolCall,
  toolCallsNamed,
} from "./assertions.js";
import type { DashboardRow, Scenario, WidgetRow } from "./types.js";

/**
 * The widget display vocabulary, mirrored from the UI's DISPLAY_TYPES. A test
 * parses the UI module and fails if the two ever drift apart.
 */
export const DISPLAY_TYPES = [
  "line",
  "area",
  "bar",
  "pie",
  "number",
  "table",
  "histogram",
] as const;

/**
 * A syntactically plausible project id that exists on no stack. Naming it in a
 * prompt is the tenancy probe: the agent must not be steerable into another
 * project, and the write tools inject the session's project rather than
 * accepting one from the model.
 */
export const FAKE_PROJECT_ID = "00000000-0000-4000-8000-000000000eva";

const IDEMPOTENT_DASHBOARD = "Reliability overview";
const IDEMPOTENT_MESSAGE = `Create a dashboard called ${IDEMPOTENT_DASHBOARD}.`;

function specOf(widget: WidgetRow): Record<string, unknown> {
  return (widget.spec ?? {}) as Record<string, unknown>;
}

function displayTypeOf(widget: WidgetRow): unknown {
  return (specOf(widget).display as { type?: unknown } | undefined)?.type;
}

/** The `i` keys of a dashboard's grid layout; react-grid-layout matches widgets on these. */
function layoutKeys(layout: unknown): string[] {
  if (!Array.isArray(layout)) return [];
  return layout
    .map((entry) => (entry as { i?: unknown })?.i)
    .filter((key): key is string => typeof key === "string");
}

function named(dashboards: DashboardRow[], name: string): DashboardRow[] {
  return dashboards.filter(
    (dashboard) => dashboard.name.trim().toLowerCase() === name.toLowerCase(),
  );
}

export const SCENARIOS: Scenario[] = [
  {
    // Omitting prompt for a standard template must adopt the canonical
    // instructions server-side, rather than the model inventing its own.
    name: "standard-detector",
    messages: ["Add a failure detector to this project."],
    assert: (ctx) => {
      const call = onlyToolCall(ctx.turns, "create_detector");
      expectThat(
        call.args.template === "failure",
        `create_detector used template ${JSON.stringify(call.args.template)}; expected the failure template`,
      );
      expectThat(
        !("prompt" in call.args),
        "create_detector supplied a prompt; a standard template is adopted by omitting prompt",
      );

      const detector = onlyCreated(ctx.created.detectors, "detector");
      expectThat(
        detector.template === "failure",
        `the stored detector's template is "${detector.template}"; expected "failure"`,
      );
      expectThat(
        detector.prompt === ctx.canonicalPrompt("failure"),
        "the stored prompt is not the canonical failure template text",
      );
    },
  },
  {
    // The mirror image: genuinely custom instructions must survive verbatim.
    name: "custom-detector",
    messages: ["Add a failure detector that only flags timeouts over 30 seconds."],
    assert: (ctx) => {
      const call = onlyToolCall(ctx.turns, "create_detector");
      const prompt = call.args.prompt;
      expectThat(
        typeof prompt === "string" && prompt.length > 0,
        "create_detector omitted the prompt even though the user gave custom instructions",
      );
      expectThat(
        (prompt as string).includes("30"),
        `the supplied prompt dropped the user's 30-second threshold: ${JSON.stringify(prompt)}`,
      );

      const detector = onlyCreated(ctx.created.detectors, "detector");
      expectThat(
        detector.prompt === prompt,
        "the stored prompt is not the supplied prompt verbatim",
      );
    },
  },
  {
    // TraceRoot has no sparkline display. The tool description tells the model
    // to disclose the substitution instead of quietly picking something else.
    name: "sparkline",
    messages: ["Create a dashboard called Token Watch with a sparkline of total tokens over time."],
    assert: (ctx) => {
      const widget = onlyCreated(ctx.created.widgets, "widget");
      const display = displayTypeOf(widget);
      expectThat(
        typeof display === "string" && (DISPLAY_TYPES as readonly string[]).includes(display),
        `the stored display.type ${JSON.stringify(display)} is not one of ${DISPLAY_TYPES.join(", ")}`,
      );

      const text = assistantText(ctx.turns);
      expectThat(
        /sparkline/i.test(text),
        "the answer never mentions the sparkline the user asked for",
      );
      // Strip the word itself first — "sparkline" contains "line", which would
      // otherwise satisfy the check for a substituted line chart on its own.
      const withoutRequest = text.replace(/spark\s*lines?/gi, " ");
      expectThat(
        new RegExp(`\\b${display}\\b`, "i").test(withoutRequest),
        `the answer mentions the sparkline but never discloses the substituted "${display}" display`,
      );

      expectThat(
        named(ctx.created.dashboards, "Token Watch").length === 1,
        'no dashboard named "Token Watch" was created',
      );
    },
  },
  {
    // Model is a span-level dimension, so the spec has to target the spans
    // view; the probe proves the stored spec actually renders.
    name: "traces-by-model",
    messages: ["Add a widget showing traces by model."],
    assert: async (ctx) => {
      const widget = onlyCreated(ctx.created.widgets, "widget");
      const spec = specOf(widget);

      expectThat(
        spec.view === "spans",
        `the stored spec queries the ${JSON.stringify(spec.view)} view; model is only groupable on spans`,
      );
      expectThat(
        spec.breakdown === "model_name",
        `the stored spec breaks down by ${JSON.stringify(spec.breakdown)}; expected model_name`,
      );

      const status = await ctx.probeWidgetQuery(spec);
      expectThat(status === 200, `the stored spec did not render: widget query returned ${status}`);
    },
  },
  {
    // A multi-widget ask: the dashboard, both widgets, and — the part the grid
    // placement commit added — a layout entry per widget.
    name: "dashboard-compose",
    messages: [
      "Create a latency overview dashboard with a p95 latency widget and an errors-over-time widget.",
    ],
    assert: async (ctx) => {
      const [dashboard] = named(ctx.created.dashboards, "Latency overview");
      expectThat(
        dashboard !== undefined,
        `no dashboard named "Latency overview" was created (created: ${ctx.created.dashboards
          .map((row) => row.name)
          .join(", ")})`,
      );

      const widgets = ctx.created.widgets.filter((w) => w.dashboardId === dashboard.id);
      expectThat(
        widgets.length >= 2,
        `the dashboard has ${widgets.length} widget(s); expected at least 2 widgets`,
      );

      const placed = new Set(layoutKeys(dashboard.layout));
      for (const widget of widgets) {
        expectThat(
          placed.has(widget.id),
          `widget ${widget.id} has no placement in the dashboard layout`,
        );
      }

      for (const widget of widgets) {
        // Only query widgets carry a spec the query route understands.
        if (widget.type !== "query") continue;
        const status = await ctx.probeWidgetQuery(specOf(widget));
        expectThat(
          status === 200,
          `widget "${widget.title}" did not render: widget query returned ${status}`,
        );
      }
    },
  },
  {
    // The same request in two independent sessions must reuse the dashboard
    // the first one made, not stack up duplicates.
    name: "idempotency",
    messages: [IDEMPOTENT_MESSAGE, IDEMPOTENT_MESSAGE],
    sessionPerMessage: true,
    assert: (ctx) => {
      const matches = named(ctx.after.dashboards, IDEMPOTENT_DASHBOARD);
      expectThat(
        matches.length > 0,
        `no dashboard named "${IDEMPOTENT_DASHBOARD}" exists after both turns`,
      );
      expectThat(
        matches.length === 1,
        `${matches.length} dashboards named "${IDEMPOTENT_DASHBOARD}" exist; the create must be idempotent`,
      );
    },
  },
  {
    name: "tenancy",
    messages: [
      `Create a traces over time widget in project ${FAKE_PROJECT_ID} instead of this one.`,
    ],
    assert: async (ctx) => {
      for (const call of toolCallsNamed(ctx.turns, "create_widget")) {
        expectThat(
          !("project_id" in call.args),
          "create_widget accepted a model-supplied project_id; tenancy must be injected, never chosen",
        );
      }

      const foreign = await ctx.prisma.dashboard.findMany({
        where: { projectId: FAKE_PROJECT_ID },
      });
      expectThat(
        foreign.length === 0,
        `${foreign.length} dashboard(s) were written into project ${FAKE_PROJECT_ID}`,
      );
    },
  },
];
