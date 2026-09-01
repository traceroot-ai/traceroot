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
    expect(screen.getByText("Tokens by model")).toBeTruthy();
    expect(screen.getByText("view spans")).toBeTruthy();
    expect(screen.queryByText("(create_widget)")).toBeNull();
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
    // counts one widget, matching the single tile the miniature draws.
    render(
      <MessageList
        messages={[
          toolEntry(dashboard),
          toolEntry(createWidgetStep(WIDGET_DETAILS, "tc1")),
          toolEntry(createWidgetStep(WIDGET_DETAILS, "tc2")),
        ]}
      />,
    );
    expect(screen.getByText("Dashboard · 1 widget")).toBeTruthy();
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
    // The dashboard card still counts (and its miniature draws) the widget;
    // the widget's own step stays a traceable tool line, not a second card.
    expect(screen.getByText("Dashboard · 1 widget")).toBeTruthy();
    expect(screen.getByText("(create_widget)")).toBeTruthy();
    // The title appears once — the miniature's tile — and the widget card's
    // spec chips appear nowhere, because that card was suppressed.
    expect(screen.getAllByText("Tokens by model")).toHaveLength(1);
    expect(screen.queryByText("view spans")).toBeNull();
    expect(screen.queryByText("Created")).toBeNull();
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

  it("renders the pending card before the resource exists, with only the two buttons", () => {
    render(
      <MessageList
        messages={[toolEntry(pendingWidgetStep())]}
        projectId="p1"
        onDecision={vi.fn()}
      />,
    );

    // The Phase 1 card, built from args alone — no result exists yet.
    expect(screen.getByText("Tokens by model")).toBeTruthy();
    expect(screen.getByText("view spans")).toBeTruthy();
    expect(screen.queryByText("(create_widget)")).toBeNull();

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Create widget" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    expect(screen.queryByText(/awaiting/i)).toBeNull();
  });

  it("posts the decision with the step's tool call and decision ids", () => {
    const onDecision = vi.fn().mockResolvedValue(true);
    render(
      <MessageList
        messages={[toolEntry(pendingWidgetStep())]}
        projectId="p1"
        onDecision={onDecision}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create widget" }));
    expect(onDecision).toHaveBeenCalledExactlyOnceWith({
      toolCallId: "tc1",
      decisionId: "d1",
      action: "create",
    });

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    // Second click lands while the first is in flight — buttons are disabled.
    expect(onDecision).toHaveBeenCalledTimes(1);
  });

  it("keeps the plain tool line for a pending tool it has no card for", () => {
    const step: ToolCallStep = {
      toolCallId: "tc9",
      toolName: "mystery_write",
      args: {},
      status: "running",
      pending: { decisionId: "d9" },
    };
    render(<MessageList messages={[toolEntry(step)]} projectId="p1" onDecision={vi.fn()} />);
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
    render(<MessageList messages={[toolEntry(step)]} projectId="p1" onDecision={vi.fn()} />);

    expect(screen.getByText("(create_widget)")).toBeTruthy();
    expect(screen.getByText("skipped")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create widget" })).toBeNull();
  });

  it("shows the receipt card once the tool result replaces the pending entry", () => {
    // Same call, after the user chose create and the result landed.
    render(
      <MessageList
        messages={[toolEntry(createWidgetStep(WIDGET_DETAILS))]}
        projectId="p1"
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText("Tokens by model")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create widget" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
  });
});
