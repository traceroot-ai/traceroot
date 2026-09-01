import { describe, expect, it, vi } from "vitest";
import {
  EvalAssertionError,
  assistantText,
  expectThat,
  newRows,
  onlyCreated,
  onlyToolCall,
  probeWidgetQuery,
  readProjectRows,
  toolCallsNamed,
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
