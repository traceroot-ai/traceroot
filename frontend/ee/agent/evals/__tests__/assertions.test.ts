import { describe, expect, it, vi } from "vitest";
import {
  EvalAssertionError,
  WRITE_TOOL_NAMES,
  assistantText,
  dateMentionPattern,
  expectNoWrites,
  expectPageWindow,
  expectThat,
  figurePattern,
  mentionsDate,
  newRows,
  onlyCreated,
  onlyToolCall,
  probeWidgetQuery,
  readProjectRows,
  resultText,
  toolCallsNamed,
  toolResultsNamed,
  noUnsourcedFigures,
  writeToolCalls,
} from "../assertions.js";
import type { EvalPrisma, ProjectRows, TurnTranscript } from "../types.js";

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

const call = (name: string, args: Record<string, unknown> = {}) => ({
  toolCallId: `tc-${name}`,
  name,
  args,
});

describe("expectThat", () => {
  it("passes a true condition through", () => {
    expect(() => expectThat(true, "boom")).not.toThrow();
  });

  it("throws an EvalAssertionError carrying the message", () => {
    expect(() => expectThat(false, "boom")).toThrow(EvalAssertionError);
    expect(() => expectThat(false, "boom")).toThrow("boom");
  });
});

describe("toolCallsNamed", () => {
  it("collects matching calls across every turn", () => {
    const turns = [
      turn({ toolCalls: [call("create_widget"), call("create_dashboard")] }),
      turn({ toolCalls: [call("create_widget")] }),
    ];
    expect(toolCallsNamed(turns, "create_widget")).toHaveLength(2);
  });

  it("returns an empty list when the tool was never called", () => {
    expect(toolCallsNamed([turn()], "create_detector")).toEqual([]);
  });
});

describe("onlyToolCall", () => {
  it("returns the single matching call", () => {
    const turns = [turn({ toolCalls: [call("create_detector", { template: "failure" })] })];
    expect(onlyToolCall(turns, "create_detector").args).toEqual({ template: "failure" });
  });

  it("fails when the tool was never called", () => {
    expect(() => onlyToolCall([turn()], "create_detector")).toThrow(/never called/);
  });

  it("fails when the tool was called more than once", () => {
    const turns = [turn({ toolCalls: [call("create_detector"), call("create_detector")] })];
    expect(() => onlyToolCall(turns, "create_detector")).toThrow(/2 times/);
  });

  it("reports an agent that answered instead of writing, and quotes what it said", () => {
    const turns = [
      turn({ assistantText: "Do you want a judged prompt, or a hard trigger on duration_ms?" }),
    ];
    expect(() => onlyToolCall(turns, "create_detector")).toThrow(
      /answered without calling any write tool/,
    );
    expect(() => onlyToolCall(turns, "create_detector")).toThrow(/hard trigger on duration_ms/);
  });

  it("counts only write tools, so a read-only turn still reads as ask-instead-of-act", () => {
    const turns = [turn({ toolCalls: [call("list_detectors")], assistantText: "Which template?" })];
    expect(() => onlyToolCall(turns, "create_detector")).toThrow(
      /answered without calling any write tool/,
    );
  });

  it("keeps the plain message when the agent wrote something else", () => {
    const turns = [turn({ toolCalls: [call("create_dashboard")], assistantText: "Done." })];
    expect(() => onlyToolCall(turns, "create_detector")).toThrow(
      /^create_detector was never called/,
    );
  });

  it("keeps the plain message when the agent said nothing at all", () => {
    expect(() => onlyToolCall([turn()], "create_detector")).toThrow(
      /^create_detector was never called/,
    );
  });

  it("collapses and truncates a long answer so the failure stays readable", () => {
    const turns = [turn({ assistantText: `First line.\n\n${"word ".repeat(200)}` })];
    let message = "";
    try {
      onlyToolCall(turns, "create_detector");
    } catch (failure) {
      message = (failure as Error).message;
    }
    expect(message).toContain("First line. word");
    expect(message).toContain("…");
    expect(message.length).toBeLessThan(400);
  });
});

describe("assistantText", () => {
  it("joins the assistant text of every turn", () => {
    const turns = [turn({ assistantText: "one" }), turn({ assistantText: "two" })];
    expect(assistantText(turns)).toBe("one\ntwo");
  });
});

describe("readProjectRows", () => {
  it("reads detectors and dashboards-with-widgets for the project", async () => {
    const prisma = {
      detector: { findMany: vi.fn().mockResolvedValue([{ id: "d-1" }]) },
      dashboard: { findMany: vi.fn().mockResolvedValue([{ id: "db-1", widgets: [] }]) },
    } as unknown as EvalPrisma;

    const rows = await readProjectRows(prisma, "proj-1");

    expect(rows.detectors).toEqual([{ id: "d-1" }]);
    expect(rows.dashboards).toEqual([{ id: "db-1", widgets: [] }]);
    expect(prisma.detector.findMany).toHaveBeenCalledWith({ where: { projectId: "proj-1" } });
    expect(prisma.dashboard.findMany).toHaveBeenCalledWith({
      where: { projectId: "proj-1" },
      include: { widgets: true },
    });
  });
});

describe("newRows", () => {
  const before: ProjectRows = {
    detectors: [{ id: "d-1", name: "old", template: "failure", prompt: "p" }],
    dashboards: [
      {
        id: "db-1",
        name: "Default",
        layout: [],
        widgets: [{ id: "w-1", dashboardId: "db-1", title: "old", type: "query", spec: {} }],
      },
    ],
  };

  it("returns only rows absent from the earlier read", () => {
    const after: ProjectRows = {
      detectors: [
        ...before.detectors,
        { id: "d-2", name: "new", template: "failure", prompt: "p" },
      ],
      dashboards: [...before.dashboards, { id: "db-2", name: "Latency", layout: [], widgets: [] }],
    };

    const created = newRows(before, after);
    expect(created.detectors.map((d) => d.id)).toEqual(["d-2"]);
    expect(created.dashboards.map((d) => d.id)).toEqual(["db-2"]);
    expect(created.widgets).toEqual([]);
  });

  it("detects a widget added to a dashboard that already existed", () => {
    const after: ProjectRows = {
      detectors: before.detectors,
      dashboards: [
        {
          ...before.dashboards[0]!,
          widgets: [
            ...before.dashboards[0]!.widgets,
            { id: "w-2", dashboardId: "db-1", title: "new", type: "query", spec: {} },
          ],
        },
      ],
    };

    expect(newRows(before, after).widgets.map((w) => w.id)).toEqual(["w-2"]);
  });

  it("returns nothing when the project is unchanged", () => {
    const created = newRows(before, before);
    expect(created).toEqual({ detectors: [], dashboards: [], widgets: [] });
  });
});

describe("onlyCreated", () => {
  it("returns the single created row", () => {
    expect(onlyCreated([{ id: "d-1" }], "detector")).toEqual({ id: "d-1" });
  });

  it("fails when nothing was created", () => {
    expect(() => onlyCreated([], "detector")).toThrow(/no detector/);
  });

  it("fails when several rows were created", () => {
    expect(() => onlyCreated([{ id: "a" }, { id: "b" }], "detector")).toThrow(/2 detector/);
  });
});

describe("probeWidgetQuery", () => {
  const spec = { view: "spans", metric: { measure: "count", agg: "count" } };

  function probeWith(response: Response) {
    const fetchImpl = vi.fn().mockResolvedValue(response);
    return {
      fetchImpl,
      run: () =>
        probeWidgetQuery(spec, {
          baseUrl: "http://api.test",
          projectId: "proj-1",
          userId: "u-1",
          userEmail: "eval@example.com",
          fetchImpl: fetchImpl as never,
          now: () => new Date("2026-09-01T00:00:00.000Z"),
        }),
    };
  }

  it("posts the spec with the dashboard time window to the widget query route", async () => {
    const { fetchImpl, run } = probeWith(new Response("{}", { status: 200 }));
    await run();

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://api.test/projects/proj-1/widgets/query");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      spec,
      start_time: "2026-08-31T00:00:00.000Z",
      end_time: "2026-09-01T00:00:00.000Z",
    });
  });

  it("sends the trace-API user headers the dashboard UI sends", async () => {
    const { fetchImpl, run } = probeWith(new Response("{}", { status: 200 }));
    await run();

    const init = fetchImpl.mock.calls[0][1];
    expect(init.headers["x-user-id"]).toBe("u-1");
    expect(init.headers["x-user-email"]).toBe("eval@example.com");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("returns the status so the caller can assert the spec is renderable", async () => {
    const { run } = probeWith(new Response("{}", { status: 200 }));
    await expect(run()).resolves.toBe(200);
  });

  it("returns the rejection status rather than throwing", async () => {
    const { run } = probeWith(new Response("{}", { status: 422 }));
    await expect(run()).resolves.toBe(422);
  });
});

describe("noUnsourcedFigures", () => {
  const turn = (assistantText: string, results: unknown[], sessionId = "s") =>
    ({
      sessionId,
      message: "m",
      toolCalls: [],
      toolResults: results.map((result, i) => ({
        toolCallId: `c${i}`,
        name: "get_dashboard_data",
        isError: false,
        result,
      })),
      assistantText,
      events: [],
    }) as never;

  it("treats a tool result with no payload as sourcing nothing, instead of throwing", () => {
    expect(() => noUnsourcedFigures([turn("Errors rose to 412.", [undefined])])).toThrow(/412/);
    expect(() => noUnsourcedFigures([turn("No data.", [undefined])])).not.toThrow();
  });

  it("counts a negative figure as a claim, while a hyphenated name is still a name", () => {
    expect(() => noUnsourcedFigures([turn("Latency changed by -5 ms.", ["value: 5"])])).toThrow(
      /-5/,
    );
    expect(() => noUnsourcedFigures([turn("gpt-5 handled it.", ["gpt-5"])])).not.toThrow();
    expect(() => noUnsourcedFigures([turn("Down -5 ms.", ["delta -5"])])).not.toThrow();
  });

  it("still sources a day or month quoted out of a result's date", () => {
    expect(() =>
      noUnsourcedFigures([
        turn("From Aug 31 to Sep 7.", ["2026-08-31T18:04Z → 2026-09-07T18:04Z"]),
      ]),
    ).not.toThrow();
  });

  it("passes when every figure in the reply appears in a tool result of the turn", () => {
    const result = "Window: range 7d (2026-08-31T18:04Z)\nvalue: 1,204,311\nmin 1.2 | max 1.84";
    expect(() =>
      noUnsourcedFigures([turn("Over 7 days p95 peaked at 1.84 s; 1,204,311 tokens.", [result])]),
    ).not.toThrow();
  });

  it("fails on a figure no tool result contained, naming it", () => {
    expect(() => noUnsourcedFigures([turn("Errors rose 12% to 412.", ["value: 412"])])).toThrow(
      /no tool result contained: 12/,
    );
  });

  it("accepts a share the reply's own sourced figures reconcile", () => {
    const results = ["value: 219292", "value: 384412"];
    expect(() =>
      noUnsourcedFigures([turn("219,292 of 384,412 tokens — ~57% of the window.", results)]),
    ).not.toThrow();
    expect(() =>
      noUnsourcedFigures([turn("219,292 of 384,412 tokens — ~92% of the window.", results)]),
    ).toThrow(/no tool result contained: 92/);
  });

  it("treats thousands separators as the same figure", () => {
    expect(() => noUnsourcedFigures([turn("1204311 tokens", ["1,204,311"])])).not.toThrow();
  });

  it("ignores digits that are part of a name, such as p95 or gpt-5", () => {
    expect(() =>
      noUnsourcedFigures([turn("p95 for gpt-5 was 1.84 s", ["max 1.84"])]),
    ).not.toThrow();
  });

  it("passes a reply with no figures at all, such as an honest no-data answer", () => {
    expect(() =>
      noUnsourcedFigures([turn("No data in this window.", ["No rows in this window."])]),
    ).not.toThrow();
  });

  it("sources a figure an earlier turn of the same session returned", () => {
    expect(() =>
      noUnsourcedFigures([
        turn("Total: 18,000 tokens.", ["value: 18,000"]),
        turn("A steady 3,000 a day — 18,000 over the window.", ["min 0 | max 3,000"]),
      ]),
    ).not.toThrow();
  });

  it("still fails a figure no turn of the session returned", () => {
    expect(() =>
      noUnsourcedFigures([
        turn("Total: 18,000 tokens.", ["value: 18,000"]),
        turn("Errors peaked at 412.", ["min 0 | max 3,000"]),
      ]),
    ).toThrow(/no tool result contained: 412/);
  });

  it("judges a fresh session on its own results, not the previous session's", () => {
    expect(() =>
      noUnsourcedFigures([
        turn("Total: 18,000 tokens.", ["value: 18,000"], "s1"),
        turn("Still 18,000.", ["No rows in this window."], "s2"),
      ]),
    ).toThrow(/no tool result contained: 18,000/);
  });

  it("exempts ratio notation while a percentage stays a claim", () => {
    expect(() =>
      noUnsourcedFigures([
        turn("The split is exactly 1:1 — eval-max-1 at 9,000 and eval-mini-1 at 9,000.", [
          "eval-max-1 | 9,000\neval-mini-1 | 9,000",
        ]),
      ]),
    ).not.toThrow();
    expect(() =>
      noUnsourcedFigures([turn("gpt-5 costs about 6.7x the rest.", ["gpt-5 | 1.34"])]),
    ).not.toThrow();
    expect(() => noUnsourcedFigures([turn("Errors rose 12% to 412.", ["value: 412"])])).toThrow(
      /no tool result contained: 12/,
    );
  });
});

describe("noUnsourcedFigures share scoping", () => {
  const turn = (assistantText: string, results: unknown[]) =>
    ({
      sessionId: "s",
      message: "m",
      toolCalls: [],
      toolResults: results.map((result, i) => ({
        toolCallId: `c${i}`,
        name: "get_dashboard_data",
        isError: false,
        result,
      })),
      assistantText,
      events: [],
    }) as never;

  it("reconciles a share only against sourced figures in the same sentence", () => {
    const results = ["value: 219292", "value: 384412"];
    expect(() =>
      noUnsourcedFigures([
        turn("The spike was 219,292 of 384,412 tokens. Errors rose by 57%.", results),
      ]),
    ).toThrow(/no tool result contained: 57/);
  });

  it("checks both sides of a fraction: a quantity over a quantity is two figures", () => {
    expect(() => noUnsourcedFigures([turn("12/500 traces failed.", ["count: 500"])])).toThrow(
      /no tool result contained: 12/,
    );
    expect(() => noUnsourcedFigures([turn("a 3:1 split, 6.7x more", ["value: 1"])])).not.toThrow();
  });
});

describe("WRITE_TOOL_NAMES", () => {
  it("holds the tools that actually change state", () => {
    expect(WRITE_TOOL_NAMES.has("create_dashboard")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("create_widget")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("create_detector")).toBe(true);
  });

  it("excludes the query tool, a POST that only reads", () => {
    // Filtering on the method alone would put it here and make every read
    // scenario that answers a metric question look like a write.
    expect(WRITE_TOOL_NAMES.has("run_widget_query")).toBe(false);
  });

  it("excludes plain reads", () => {
    expect(WRITE_TOOL_NAMES.has("get_dashboard_data")).toBe(false);
    expect(WRITE_TOOL_NAMES.has("list_dashboards")).toBe(false);
  });
});

describe("writeToolCalls and expectNoWrites", () => {
  it("collects only the write calls, across turns", () => {
    const turns = [
      turn({ toolCalls: [call("run_widget_query"), call("create_widget")] }),
      turn({ toolCalls: [call("get_dashboard_data")] }),
    ];
    expect(writeToolCalls(turns).map((c) => c.name)).toEqual(["create_widget"]);
  });

  it("passes a read-only turn", () => {
    const turns = [turn({ toolCalls: [call("run_widget_query"), call("list_dashboards")] })];
    expect(() => expectNoWrites(turns, "reading")).not.toThrow();
  });

  it("names what was written when a write slipped in", () => {
    const turns = [turn({ toolCalls: [call("create_dashboard"), call("create_dashboard")] })];
    expect(() => expectNoWrites(turns, "reading")).toThrow(/reading called create_dashboard/);
  });
});

describe("expectPageWindow", () => {
  it("passes when the reads named no window at all", () => {
    const turns = [turn({ toolCalls: [call("run_widget_query", { spec: {} })] })];
    expect(() => expectPageWindow(turns, "14d")).not.toThrow();
  });

  it("passes when a read echoed the page's own range", () => {
    const turns = [turn({ toolCalls: [call("get_dashboard_data", { range: "14d" })] })];
    expect(() => expectPageWindow(turns, "14d")).not.toThrow();
  });

  it("fails when a read chose a different range", () => {
    const turns = [turn({ toolCalls: [call("run_widget_query", { range: "1d" })] })];
    expect(() => expectPageWindow(turns, "14d")).toThrow(/asked for range "1d"/);
  });

  it("fails when a read pinned its own bounds", () => {
    const turns = [
      turn({ toolCalls: [call("run_widget_query", { start_time: "2026-09-01T00:00:00Z" })] }),
    ];
    expect(() => expectPageWindow(turns, "14d")).toThrow(/pinned its own bounds/);
  });

  it("ignores calls that take no window", () => {
    const turns = [turn({ toolCalls: [call("list_traces", { range: "1d" })] })];
    expect(() => expectPageWindow(turns, "14d")).not.toThrow();
  });
});

describe("toolResultsNamed and resultText", () => {
  const result = (name: string, payload: unknown, isError = false) => ({
    toolCallId: `tc-${name}`,
    name,
    isError,
    result: payload,
  });

  it("collects a tool's results across turns", () => {
    const turns = [
      turn({ toolResults: [result("run_widget_query", "a"), result("list_traces", "b")] }),
      turn({ toolResults: [result("run_widget_query", "c")] }),
    ];
    expect(toolResultsNamed(turns, "run_widget_query").map((r) => r.result)).toEqual(["a", "c"]);
  });

  it("renders a result as searchable text", () => {
    expect(resultText(result("run_widget_query", "Window: range 14d"))).toContain("range 14d");
  });

  it("renders a payload-less result as an empty string", () => {
    expect(resultText(result("run_widget_query", undefined))).toBe("");
  });
});

describe("figurePattern", () => {
  it("matches the figure with or without thousands separators", () => {
    const pattern = figurePattern(219292);
    expect(pattern.test("219,292 tokens")).toBe(true);
    expect(pattern.test("219292 tokens")).toBe(true);
    expect(pattern.test("219 292 tokens")).toBe(true);
  });

  it("does not match a different figure", () => {
    expect(figurePattern(219292).test("219,000 tokens")).toBe(false);
    expect(figurePattern(18000).test("18,001")).toBe(false);
  });

  it("groups every triple, not just the last one", () => {
    expect(figurePattern(1234567).test("1,234,567")).toBe(true);
  });
});

describe("dateMentionPattern", () => {
  it("matches the ISO form the tool results carry", () => {
    expect(mentionsDate("the spike was on 2026-08-31", "2026-08-31")).toBe(true);
  });

  it("matches either English word order, long or abbreviated", () => {
    for (const written of ["August 31", "Aug 31", "Aug 31st", "31 August", "31 Aug"]) {
      expect(mentionsDate(`usage peaked on ${written}`, "2026-08-31")).toBe(true);
    }
  });

  it("matches an abbreviation between the short and long spellings", () => {
    // "Sept" is standard English and falls between "Sep" and "September"; the
    // month accepts any 3+-letter prefix, with or without an abbreviating dot.
    expect(mentionsDate("the spike was on Sept 1", "2026-09-01")).toBe(true);
    expect(mentionsDate("the spike was on Sept. 1", "2026-09-01")).toBe(true);
  });

  it("matches a leading zero on the day", () => {
    expect(mentionsDate("errors on Sep 06", "2026-09-06")).toBe(true);
    expect(mentionsDate("errors on September 6", "2026-09-06")).toBe(true);
  });

  it("does not match a neighbouring day or the wrong month", () => {
    expect(mentionsDate("usage peaked on August 30", "2026-08-31")).toBe(false);
    expect(mentionsDate("usage peaked on July 31", "2026-08-31")).toBe(false);
    expect(mentionsDate("usage peaked on 2026-08-30", "2026-08-31")).toBe(false);
  });

  it("does not read a bare number as a date", () => {
    expect(mentionsDate("there were 31 traces", "2026-08-31")).toBe(false);
  });

  it("anchors the day, so a longer number is not a match", () => {
    expect(dateMentionPattern("2026-09-06").test("September 60")).toBe(false);
  });
});
