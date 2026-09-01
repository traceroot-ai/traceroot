// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MessageList } from "./message-list";
import type { AIMessage, ToolCallStep } from "../types";

afterEach(cleanup);

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

  it("counts the widgets created into a dashboard on the dashboard's card", () => {
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
        messages={[
          toolEntry(dashboard),
          toolEntry(createWidgetStep(WIDGET_DETAILS, "tc1")),
          toolEntry(createWidgetStep(WIDGET_DETAILS, "tc2")),
        ]}
      />,
    );
    expect(screen.getByText("Dashboard · 2 widgets")).toBeTruthy();
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
