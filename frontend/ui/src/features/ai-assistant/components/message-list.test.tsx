// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as api from "@/features/dashboards/api";
import { MessageList } from "./message-list";
import type { AIMessage, ToolCallStep } from "../types";

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1", email: "u@example.com" } }, isPending: false }),
}));
vi.mock("@/features/dashboards/api");

// Counts model builds without changing behavior, so a test can assert that a
// streamed text delta does not rebuild every card in the transcript.
const cardModelCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../lib/resource-card", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/resource-card")>();
  return {
    ...actual,
    resourceCardModel: (...args: Parameters<typeof actual.resourceCardModel>) => {
      cardModelCalls.count += 1;
      return actual.resourceCardModel(...args);
    },
  };
});

// jsdom has no IntersectionObserver, so a widget card's chart preview stays
// unqueried until a test scrolls it into view.
const observers: (() => void)[] = [];
const intersect = () => act(() => observers.forEach((fire) => fire()));

beforeEach(() => {
  observers.length = 0;
  // The chart-query mock is per-test state: a test that makes it reject must
  // not decide what the next test's card renders.
  vi.mocked(api.runWidgetQuery).mockReset();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(element: Element) {
        observers.push(() =>
          this.cb(
            [{ isIntersecting: true, target: element } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          ),
        );
      }
      disconnect() {}
      unobserve() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function toolEntry(step: ToolCallStep): AIMessage {
  return {
    id: step.toolCallId,
    role: "tool_step",
    content: "",
    timestamp: "2026-01-02T03:04:05.000Z",
    toolStep: step,
  };
}

function createWidgetStep(details: unknown, toolCallId = "tc1"): ToolCallStep {
  return {
    toolCallId,
    toolName: "create_widget",
    args: {
      dashboard_id: "db1",
      title: "Tokens by model",
      type: "query",
      spec: {
        view: "spans",
        metric: { measure: "total_tokens", agg: "sum" },
        display: { type: "bar" },
      },
    },
    result: { content: [{ type: "text", text: "Created widget" }], details },
    isError: false,
    status: "done",
  };
}

const WIDGET_DETAILS = {
  kind: "resource_created",
  resourceType: "widget",
  resourceId: "w1",
  created: true,
  projectId: "p1",
  dashboardId: "db1",
};

describe("MessageList tool entries", () => {
  it("shows a created resource as a card instead of a tool line", () => {
    render(<MessageList messages={[toolEntry(createWidgetStep(WIDGET_DETAILS))]} />);
    expect(screen.queryByText("(create_widget)")).toBeNull();
    // The card's footer names it; its spec chips sit behind the title.
    fireEvent.click(screen.getByRole("button", { name: "Tokens by model" }));
    expect(screen.getByText("view spans")).toBeTruthy();
  });

  it("counts a replayed widget create once on the dashboard's card", () => {
    const dashboard: ToolCallStep = {
      toolCallId: "tc0",
      toolName: "create_dashboard",
      args: { name: "Latency overview" },
      result: {
        content: [{ type: "text", text: "Created dashboard" }],
        details: {
          kind: "resource_created",
          resourceType: "dashboard",
          resourceId: "db1",
          created: true,
          projectId: "p1",
        },
      },
      isError: false,
      status: "done",
    };
    // Both steps carry the same widget id — a replayed create — so the card
    // counts one widget, matching the single tile the preview draws.
    render(
      <MessageList
        messages={[
          toolEntry(dashboard),
          toolEntry(createWidgetStep(WIDGET_DETAILS, "tc1")),
          toolEntry(createWidgetStep(WIDGET_DETAILS, "tc2")),
        ]}
      />,
    );
    expect(screen.getByText("Dashboard · 1 widget · Last 24 hours")).toBeTruthy();
  });

  it("keeps the plain tool step for a resource type it has no card for", () => {
    const step = createWidgetStep({
      kind: "resource_created",
      resourceType: "sandwich",
      resourceId: "s1",
      created: true,
    });
    render(<MessageList messages={[toolEntry(step)]} />);
    expect(screen.getByText("(create_widget)")).toBeTruthy();
    expect(screen.queryByText("Created")).toBeNull();
  });

  it("keeps the plain tool step when a successful write reported no details", () => {
    render(<MessageList messages={[toolEntry(createWidgetStep(null))]} />);
    expect(screen.getByText("(create_widget)")).toBeTruthy();
    expect(screen.queryByText("Created")).toBeNull();
  });

  it("keeps the plain tool step for a call that is still running", () => {
    const running: ToolCallStep = { ...createWidgetStep(undefined), status: "running" };
    render(<MessageList messages={[toolEntry(running)]} />);
    expect(screen.getByText("(create_widget)")).toBeTruthy();
  });

  it("keeps rendering the transcript when a card's chart query fails", async () => {
    vi.mocked(api.runWidgetQuery).mockRejectedValue(new Error("clickhouse exploded"));
    const chartable = createWidgetStep(WIDGET_DETAILS);
    chartable.args.spec = {
      view: "spans",
      metric: { measure: "total_tokens", agg: "sum" },
      display: { type: "number" },
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MessageList
          messages={[
            toolEntry(chartable),
            { id: "a1", role: "assistant", content: "done", timestamp: "2026-01-02T03:04:06Z" },
          ]}
        />
      </QueryClientProvider>,
    );
    // The preview arrives through next/dynamic, so its observer registers a
    // tick after render; only then can the card be scrolled into view.
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));
    intersect();

    // The dashboard's query hook retries once, so the message lands a
    // retry-backoff after the card itself.
    await screen.findByText(/couldn't load/i, undefined, { timeout: 5000 });
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByText("Tokens by model")).toBeTruthy();
  });

  it("does not leak the failing chart query into the tests that follow", async () => {
    // The rejection above is one test's stub. beforeEach resets the mock, so a
    // later card's query resolves instead of replaying that failure.
    const query = vi.mocked(api.runWidgetQuery);
    await expect(Promise.resolve(query("p1", {} as never, {} as never))).resolves.toBeUndefined();
  });

  it("keeps the plain tool line for a widget whose dashboard carded earlier in the transcript", () => {
    const dashboard: ToolCallStep = {
      toolCallId: "tc0",
      toolName: "create_dashboard",
      args: { name: "Latency overview" },
      result: {
        content: [{ type: "text", text: "Created dashboard" }],
        details: {
          kind: "resource_created",
          resourceType: "dashboard",
          resourceId: "db1",
          created: true,
          projectId: "p1",
        },
      },
      isError: false,
      status: "done",
    };
    render(
      <MessageList
        messages={[toolEntry(dashboard), toolEntry(createWidgetStep(WIDGET_DETAILS, "tc1"))]}
      />,
    );
    // The dashboard card still counts (and its preview draws) the widget;
    // the widget's own step stays a traceable tool line, not a second card.
    expect(screen.getByText("Dashboard · 1 widget · Last 24 hours")).toBeTruthy();
    expect(screen.getByText("(create_widget)")).toBeTruthy();
    // The title appears once — the preview's tile — and there is no card
    // footer (no definition toggle) for the widget, because its card was
    // suppressed.
    expect(screen.getAllByText("Tokens by model")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Tokens by model" })).toBeNull();
    expect(screen.queryByText("Created")).toBeNull();
  });

  it("keeps widget cards under a reused dashboard's card — they are the only receipt", () => {
    const reused: ToolCallStep = {
      toolCallId: "tc0",
      toolName: "create_dashboard",
      args: { name: "Latency overview" },
      result: {
        content: [{ type: "text", text: "Reused dashboard" }],
        details: {
          kind: "resource_created",
          resourceType: "dashboard",
          resourceId: "db1",
          created: false,
          projectId: "p1",
        },
      },
      isError: false,
      status: "done",
    };
    const { container } = render(
      <MessageList
        messages={[toolEntry(reused), toolEntry(createWidgetStep(WIDGET_DETAILS, "tc1"))]}
      />,
    );
    // The dashboard card keeps the count but draws no preview — the real
    // grid's placements are unknowable from this transcript.
    expect(screen.getByText("Dashboard · 1 widget")).toBeTruthy();
    expect(screen.getByText("Reused")).toBeTruthy();
    expect(container.querySelector("[data-preview-tile]")).toBeNull();
    // The widget keeps its full card — no preview stands in for it.
    expect(screen.queryByText("(create_widget)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tokens by model" }));
    expect(screen.getByText("view spans")).toBeTruthy();
  });

  it("does not rebuild card models when a text delta streams in", () => {
    const toolMsg = toolEntry(createWidgetStep(WIDGET_DETAILS));
    const streaming = (content: string): AIMessage => ({
      id: "a1",
      role: "assistant",
      content,
      timestamp: "2026-01-02T03:04:06.000Z",
      isStreaming: true,
    });
    const { rerender } = render(<MessageList messages={[toolMsg, streaming("Hel")]} />);
    const afterFirstRender = cardModelCalls.count;
    expect(afterFirstRender).toBeGreaterThan(0);

    // A delta replaces the messages array and the streaming bubble but reuses
    // the untouched tool-step entry object — exactly what the stream hook
    // does — so the card models (and their query-holding subtrees) stand.
    rerender(<MessageList messages={[toolMsg, streaming("Hello")]} />);
    rerender(<MessageList messages={[toolMsg, streaming("Hello there")]} />);
    expect(cardModelCalls.count).toBe(afterFirstRender);
  });

  it("keeps the full card for a widget whose dashboard has no card in the transcript", () => {
    // dashboardId db1 appears nowhere else — the widget landed in a
    // pre-existing dashboard, so its card is the only receipt there is.
    render(<MessageList messages={[toolEntry(createWidgetStep(WIDGET_DETAILS))]} />);
    expect(screen.getByText("Tokens by model")).toBeTruthy();
    expect(screen.queryByText("(create_widget)")).toBeNull();
  });

  it("sizes every card to the message column's width", () => {
    const project: ToolCallStep = {
      toolCallId: "tc7",
      toolName: "create_project",
      args: { name: "checkout-service" },
      result: {
        content: [{ type: "text", text: "Created project" }],
        details: {
          kind: "resource_created",
          resourceType: "project",
          resourceId: "p9",
          created: true,
          workspaceId: "ws1",
        },
      },
      isError: false,
      status: "done",
    };
    const dashboard: ToolCallStep = {
      toolCallId: "tc8",
      toolName: "create_dashboard",
      args: { name: "Latency overview" },
      result: {
        content: [{ type: "text", text: "Created dashboard" }],
        details: {
          kind: "resource_created",
          resourceType: "dashboard",
          resourceId: "db2",
          created: true,
          projectId: "p1",
        },
      },
      isError: false,
      status: "done",
    };
    // Three card kinds; the widget's dashboard (db1) has no card here, so its
    // own card stays.
    render(
      <MessageList
        messages={[
          toolEntry(project),
          toolEntry(dashboard),
          toolEntry(createWidgetStep(WIDGET_DETAILS)),
        ]}
      />,
    );
    const wrappers = ["checkout-service", "Latency overview", "Tokens by model"].map(
      (title) => screen.getByText(title).closest("div[style]") as HTMLElement,
    );
    const widths = new Set(wrappers.map((wrapper) => wrapper.style.maxWidth));
    expect(widths.size).toBe(1);
    expect(widths.has("")).toBe(false);
    for (const wrapper of wrappers) {
      expect(wrapper.className).toContain("w-full");
    }
  });

  it("leaves ordinary bubbles alone", () => {
    render(
      <MessageList
        messages={[
          { id: "u1", role: "user", content: "make me a chart", timestamp: "2026-01-02T03:04:05Z" },
          toolEntry(createWidgetStep(WIDGET_DETAILS)),
        ]}
      />,
    );
    expect(screen.getByText("make me a chart")).toBeTruthy();
    expect(screen.getByText("Tokens by model")).toBeTruthy();
  });
});

describe("MessageList read result entries", () => {
  const ALERT_ROW = {
    id: "al-1",
    name: "p95 latency over 2s",
    view: "SPANS",
    measure: "latency",
    aggregation: "p95",
    window: "10m",
    threshold_operator: ">",
    threshold: 2000,
    status: "ACTIVE",
    severity: "OK",
    alerted_at: null,
    last_evaluated_at: "2026-09-11T14:48:00Z",
    last_error: null,
    last_notify_status: null,
    last_notify_error: null,
    last_notify_at: null,
  };

  function readStep(toolName: string, details: unknown, toolCallId = "tcr1"): ToolCallStep {
    return {
      toolCallId,
      toolName,
      args: {},
      result: { content: [{ type: "text", text: "Found 1 alerts" }], details },
      isError: false,
      status: "done",
    };
  }

  it("renders a list_alerts read as the list card, rows linked under the panel's project", () => {
    render(
      <MessageList
        messages={[
          toolEntry(
            readStep("list_alerts", {
              kind: "alert_list",
              alerts: [ALERT_ROW],
              total: 1,
              capacity: { used: 1, max: 100 },
            }),
          ),
        ]}
        projectId="p1"
      />,
    );
    expect(screen.getByText("p95 latency over 2s")).toBeTruthy();
    expect(screen.getByText(/p95 latency > 2,000 ms over 10m/)).toBeTruthy();
    expect(screen.getByText("OK")).toBeTruthy();
    expect(screen.getByText("1 of 100 used")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open alerts" }).getAttribute("href")).toBe(
      "/projects/p1/alerts",
    );
    expect(screen.queryByText("(list_alerts)")).toBeNull();
  });

  it("renders a get_alert read as the alert's card with its definition open", () => {
    render(
      <MessageList
        messages={[
          toolEntry(
            readStep("get_alert", {
              kind: "alert_detail",
              alert: {
                ...ALERT_ROW,
                filters: [],
                renotify: { mode: "OFF" },
                no_data_mode: "HOLD",
                creator: "Kai",
                create_time: "2026-09-04T09:00:00Z",
              },
            }),
          ),
        ]}
        projectId="p1"
      />,
    );
    expect(screen.getByText("p95 latency over 2s")).toBeTruthy();
    expect(screen.getByText("p95(latency)")).toBeTruthy();
    expect(screen.getByText("renotify off")).toBeTruthy();
    expect(screen.getByText("created by")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open alert" }).getAttribute("href")).toBe(
      "/projects/p1/alerts/al-1",
    );
    expect(screen.queryByText("(get_alert)")).toBeNull();
  });

  it("keeps the plain tool line for a read whose result carries no card details, or failed", () => {
    render(
      <MessageList
        messages={[
          toolEntry(readStep("list_alerts", undefined, "tcr1")),
          toolEntry({
            ...readStep("list_alerts", { kind: "alert_list", alerts: [ALERT_ROW] }, "tcr2"),
            isError: true,
          }),
        ]}
        projectId="p1"
      />,
    );
    expect(screen.getAllByText("(list_alerts)")).toHaveLength(2);
    expect(screen.queryByText("p95 latency over 2s")).toBeNull();
  });
});

describe("MessageList pending confirmation entries", () => {
  function pendingWidgetStep(toolCallId = "tc1"): ToolCallStep {
    return {
      toolCallId,
      toolName: "create_widget",
      args: {
        dashboard_id: "db1",
        title: "Tokens by model",
        type: "query",
        spec: {
          view: "spans",
          metric: { measure: "total_tokens", agg: "sum" },
          display: { type: "bar" },
        },
      },
      status: "running",
      pending: { decisionId: "d1" },
    };
  }

  it("renders the pending card before the resource exists, marked proposed and without decision buttons", () => {
    render(<MessageList messages={[toolEntry(pendingWidgetStep())]} projectId="p1" />);

    // The card, built from args alone — no result exists yet.
    expect(screen.getByText("Tokens by model")).toBeTruthy();
    expect(screen.getByText(/^Proposed · Widget/)).toBeTruthy();
    expect(screen.queryByText("(create_widget)")).toBeNull();

    // The decision lives in the composer's approval bar, not the thread.
    expect(screen.queryByRole("button", { name: "Create widget" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(/awaiting/i)).toBeNull();
  });

  it("hides the between-turns spinner while a call is parked on the user's decision", () => {
    const { container } = render(
      <MessageList messages={[toolEntry(pendingWidgetStep())]} sessionStreaming projectId="p1" />,
    );
    // The run is alive but waiting on the user, not generating.
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("shows the between-turns spinner once the parked call is decided and the run resumes", () => {
    const decided: ToolCallStep = { ...pendingWidgetStep(), pending: undefined, status: "done" };
    const { container } = render(
      <MessageList messages={[toolEntry(decided)]} sessionStreaming projectId="p1" />,
    );
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("keeps the plain tool line for a pending tool it has no card for", () => {
    const step: ToolCallStep = {
      toolCallId: "tc9",
      toolName: "mystery_write",
      args: {},
      status: "running",
      pending: { decisionId: "d9" },
    };
    render(<MessageList messages={[toolEntry(step)]} projectId="p1" />);
    expect(screen.getByText("(mystery_write)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
  });

  it("collapses a skipped call to the plain tool line with a skipped note", () => {
    const step: ToolCallStep = {
      ...pendingWidgetStep(),
      pending: undefined,
      skipped: true,
      status: "error",
      isError: true,
      result: { content: [{ type: "text", text: "The user chose to skip this call." }] },
    };
    render(<MessageList messages={[toolEntry(step)]} projectId="p1" />);

    expect(screen.getByText("(create_widget)")).toBeTruthy();
    expect(screen.getByText("skipped")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create widget" })).toBeNull();
  });

  it("labels a revision-declined call with the user's requested changes, not skipped", () => {
    const step: ToolCallStep = {
      ...pendingWidgetStep(),
      pending: undefined,
      revisedText: "use p95 latency instead",
      status: "error",
      isError: true,
      result: { content: [{ type: "text", text: "This tool call was NOT executed." }] },
    };
    render(<MessageList messages={[toolEntry(step)]} projectId="p1" />);

    expect(screen.getByText("(create_widget)")).toBeTruthy();
    expect(screen.getByText("revised — use p95 latency instead")).toBeTruthy();
    expect(screen.queryByText("skipped")).toBeNull();
    expect(screen.getByText("Revised")).toBeTruthy();
  });

  it("truncates a long revision text on the tool line", () => {
    const step: ToolCallStep = {
      ...pendingWidgetStep(),
      pending: undefined,
      revisedText: "x".repeat(200),
      status: "error",
      isError: true,
    };
    render(<MessageList messages={[toolEntry(step)]} projectId="p1" />);

    expect(screen.getByText(`revised — ${"x".repeat(80)}…`)).toBeTruthy();
  });

  it("shows the receipt card once the tool result replaces the pending entry", () => {
    // Same call, after the user chose create and the result landed.
    render(<MessageList messages={[toolEntry(createWidgetStep(WIDGET_DETAILS))]} projectId="p1" />);
    expect(screen.getByText("Tokens by model")).toBeTruthy();
    expect(screen.queryByText(/Proposed/)).toBeNull();
    expect(screen.getByRole("link", { name: "Open widget" }).getAttribute("href")).toBe(
      "/projects/p1/dashboard/db1",
    );
  });
});

// ── Trace resolution and capture notes (agent self-trace) ────────────────────

const step = (id: string): AIMessage =>
  ({
    id,
    role: "tool_step",
    content: "",
    toolStep: { toolCallId: id, toolName: "read", args: {}, spanId: `span-${id}`, isError: false },
  }) as unknown as AIMessage;

const user = (id: string): AIMessage => ({ id, role: "user", content: "ask" }) as AIMessage;

const assistant = (id: string, traceId: string, traceStatus = "available"): AIMessage =>
  ({ id, role: "assistant", content: "answer", traceId, traceStatus }) as unknown as AIMessage;

/** A text segment flushed at a tool boundary: no trace stamp, no usage. */
const segment = (id: string): AIMessage =>
  ({ id, role: "assistant", content: "thinking out loud" }) as AIMessage;

/** The run's final bubble, with usage so the footer renders. */
const finalBubble = (id: string, trace?: { traceId: string; traceStatus: string }): AIMessage =>
  ({
    id,
    role: "assistant",
    content: "answer",
    inputTokens: 12,
    outputTokens: 34,
    ...trace,
  }) as unknown as AIMessage;

/** Expand every tool step so its "Open span" control is in the DOM. */
function openSteps() {
  // The step header is a button carrying the raw tool name in parentheses.
  for (const b of screen.getAllByRole("button")) {
    if (b.textContent?.includes("(read)")) fireEvent.click(b);
  }
}

describe("MessageList tool-step trace resolution", () => {
  it("links a tool step to its own turn's trace", () => {
    const onOpenTrace = vi.fn();
    render(
      <MessageList
        messages={[user("u1"), step("t1"), assistant("a1", "trace-1")]}
        onOpenTrace={onOpenTrace}
      />,
    );
    openSteps();
    fireEvent.click(screen.getByText("Open span"));
    expect(onOpenTrace).toHaveBeenCalledWith("trace-1", "span-t1");
  });

  it("does not reach past a turn boundary for a trace", () => {
    // A tool-only run produces no assistant bubble. Scanning past the next user
    // message would attach this step to the following turn's trace — a
    // different trace, which does not contain this span.
    const onOpenTrace = vi.fn();
    render(
      <MessageList
        messages={[user("u1"), step("t1"), user("u2"), assistant("a2", "trace-2")]}
        onOpenTrace={onOpenTrace}
      />,
    );
    openSteps();
    expect(screen.queryByText("Open span")).toBeNull();
  });

  it("links every step of a text → tool → text turn, not just the one before the final bubble", () => {
    // The trace is stamped on the run's last segment only; the segment right
    // after t1 carries none, and t1 used to lose its link because of it.
    const onOpenTrace = vi.fn();
    render(
      <MessageList
        messages={[user("u1"), step("t1"), segment("a1"), step("t2"), assistant("a2", "trace-1")]}
        onOpenTrace={onOpenTrace}
      />,
    );
    openSteps();
    const links = screen.getAllByText("Open span");
    expect(links).toHaveLength(2);
    fireEvent.click(links[0]);
    expect(onOpenTrace).toHaveBeenCalledWith("trace-1", "span-t1");
    fireEvent.click(links[1]);
    expect(onOpenTrace).toHaveBeenCalledWith("trace-1", "span-t2");
  });

  it("links a step while the turn's trace is still uploading (pending)", () => {
    // A chat turn ends before its upload finishes; the trace exists and fills
    // in within seconds, so the way into it is offered at once.
    const onOpenTrace = vi.fn();
    render(
      <MessageList
        messages={[user("u1"), step("t1"), assistant("a1", "trace-1", "pending")]}
        onOpenTrace={onOpenTrace}
      />,
    );
    openSteps();
    fireEvent.click(screen.getByText("Open span"));
    expect(onOpenTrace).toHaveBeenCalledWith("trace-1", "span-t1");
  });

  it("offers no link when the turn's trace failed or tracing was off", () => {
    for (const status of ["failed", "disabled"]) {
      const onOpenTrace = vi.fn();
      render(
        <MessageList
          messages={[user("u1"), step("t1"), assistant("a1", "trace-1", status)]}
          onOpenTrace={onOpenTrace}
        />,
      );
      openSteps();
      expect(screen.queryByText("Open span")).toBeNull();
      cleanup();
    }
  });
});

describe("MessageList reply-level trace entry point", () => {
  // Every turn has a way into its trace, tool calls or not (review item 4):
  // the link sits under the reply that carries the trace stamp, which is the
  // same final segment live (trace SSE frame) and after a reload (row metadata).
  it("shows View trace under a reply whose trace is available, and opens it unfocused", () => {
    const onOpenTrace = vi.fn();
    render(
      <MessageList
        messages={[user("u1"), finalBubble("a1", { traceId: "trace-1", traceStatus: "available" })]}
        onOpenTrace={onOpenTrace}
      />,
    );
    fireEvent.click(screen.getByText("View trace"));
    expect(onOpenTrace).toHaveBeenCalledWith("trace-1");
  });

  it("shows View trace while the upload is pending, and says so", () => {
    const onOpenTrace = vi.fn();
    render(
      <MessageList
        messages={[user("u1"), assistant("a1", "trace-1", "pending")]}
        onOpenTrace={onOpenTrace}
      />,
    );
    const link = screen.getByText("View trace");
    expect(link.getAttribute("title")).toMatch(/still being uploaded/);
    fireEvent.click(link);
    expect(onOpenTrace).toHaveBeenCalledWith("trace-1");
  });

  it("says a failed upload has no trace, and offers nothing for a turn without one", () => {
    render(
      <MessageList
        messages={[user("u1"), assistant("a1", "trace-1", "failed"), user("u2"), segment("a2")]}
        onOpenTrace={vi.fn()}
      />,
    );
    expect(screen.getByText("Trace not available")).toBeTruthy();
    expect(screen.queryByText("View trace")).toBeNull();
  });

  it("keeps the usage line as it was, with the link after it", () => {
    render(
      <MessageList
        messages={[user("u1"), finalBubble("a1", { traceId: "trace-1", traceStatus: "available" })]}
        onOpenTrace={vi.fn()}
      />,
    );
    const footer = screen.getByText("View trace").parentElement!;
    expect(footer.textContent).toBe("12 in·34 out·View trace");
  });

  it("offers no link without an opener, even when the trace is available", () => {
    render(
      <MessageList
        messages={[user("u1"), finalBubble("a1", { traceId: "trace-1", traceStatus: "available" })]}
      />,
    );
    expect(screen.queryByText("View trace")).toBeNull();
    expect(screen.getByText("12 in")).toBeTruthy();
  });
});

describe("MessageList reloaded tool-step capture notes", () => {
  const persistedStep = (toolStep: Record<string, unknown>): AIMessage =>
    ({
      id: "t1",
      role: "tool_step",
      content: "",
      toolStep: { toolCallId: "t1", toolName: "read", args: {}, status: "done", ...toolStep },
    }) as unknown as AIMessage;

  it("explains a withheld result instead of showing a bubble with no output", () => {
    render(
      <MessageList
        messages={[user("u1"), persistedStep({ withheld: "not-allowlisted", outputBytes: 44 })]}
      />,
    );
    openSteps();
    const note = screen.getByText("Output not stored after the run (44 bytes returned)");
    expect(note.getAttribute("title")).toMatch(/source code and secrets/);
    expect(screen.queryByText("Result")).toBeNull();
  });

  it("explains a result dropped for the run's storage limit", () => {
    render(
      <MessageList
        messages={[user("u1"), persistedStep({ withheld: "budget", outputBytes: 9001 })]}
      />,
    );
    openSteps();
    const note = screen.getByText(
      "Output not stored: this run reached its limit for stored tool output (9,001 bytes returned)",
    );
    expect(note.getAttribute("title")).toMatch(/bounded amount/);
  });

  it("marks a truncated capture next to what was kept", () => {
    render(
      <MessageList
        messages={[
          user("u1"),
          persistedStep({ result: "abc… [truncated]", truncated: true, outputBytes: 90000 }),
        ]}
      />,
    );
    openSteps();
    expect(screen.getByText("Result")).toBeTruthy();
    const note = screen.getByText("Output stored up to the per-step limit (90,000 bytes returned)");
    expect(note.getAttribute("title")).toMatch(/fixed size per step/);
  });

  it("adds no note to a live step, which shows its result in full", () => {
    render(<MessageList messages={[user("u1"), persistedStep({ result: { ok: true } })]} />);
    openSteps();
    expect(screen.getByText("Result")).toBeTruthy();
    expect(screen.queryByText(/withheld|truncated/)).toBeNull();
  });
});
