// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ResourceCard } from "./resource-card";
import type { ResourceCardModel, WidgetChart } from "../lib/resource-card";

// The preview is exercised for real in widget-chart-preview.test.tsx; here it
// stands in for itself so these tests can assert what the card hands it.
vi.mock("./widget-chart-preview", () => ({
  WidgetChartPreview: ({ projectId, widgetId, spec }: WidgetChart & { widgetId: string }) => (
    <div data-testid="preview">{`${projectId}/${widgetId}/${spec.display.type}`}</div>
  ),
}));

// Same for the miniature, exercised for real in dashboard-miniature.test.tsx.
vi.mock("./dashboard-miniature", () => ({
  DashboardMiniature: ({ tiles }: { tiles: { id: string }[] }) => (
    <div data-testid="miniature">{tiles.map((t) => t.id).join(",")}</div>
  ),
}));

afterEach(cleanup);

const CHART: WidgetChart = {
  projectId: "p1",
  spec: {
    view: "spans",
    filters: [],
    metric: { measure: "total_tokens", agg: "sum" },
    breakdown: null,
    display: { type: "line" },
  },
};

function model(overrides: Partial<ResourceCardModel> = {}): ResourceCardModel {
  return {
    resourceType: "widget",
    resourceId: "w1",
    created: true,
    title: "Tokens by model",
    meta: ["Widget"],
    body: { kind: "widget", chips: ["view spans", "sum(total_tokens)"], chart: null },
    ...overrides,
  };
}

describe("ResourceCard", () => {
  it("heads a created resource with its name, meta line and a created badge", () => {
    render(<ResourceCard model={model()} />);
    expect(screen.getByText("Tokens by model")).toBeTruthy();
    expect(screen.getByText("Widget")).toBeTruthy();
    expect(screen.getByText("Created")).toBeTruthy();
  });

  it("says a resource was reused rather than created", () => {
    render(<ResourceCard model={model({ created: false })} />);
    expect(screen.getByText("Reused")).toBeTruthy();
    expect(screen.queryByText("Created")).toBeNull();
  });

  it("carries no status badge or action button beyond the receipt itself", () => {
    const { container } = render(<ResourceCard model={model()} />);
    expect(container.querySelectorAll("button").length).toBe(0);
    expect(container.textContent).not.toContain("Awaiting");
  });

  it("joins the meta parts into one line", () => {
    render(<ResourceCard model={model({ meta: ["Dashboard", "2 widgets"] })} />);
    expect(screen.getByText("Dashboard · 2 widgets")).toBeTruthy();
  });

  it("renders a widget's spec chips", () => {
    render(<ResourceCard model={model()} />);
    expect(screen.getByText("view spans")).toBeTruthy();
    expect(screen.getByText("sum(total_tokens)")).toBeTruthy();
  });

  it("previews the created widget's own chart under its chips", async () => {
    render(
      <ResourceCard
        model={model({ body: { kind: "widget", chips: ["view spans"], chart: CHART } })}
      />,
    );
    expect(screen.getByText("view spans")).toBeTruthy();
    // findBy: the preview module is loaded through next/dynamic, so the stub
    // mounts a tick after the card renders.
    expect((await screen.findByTestId("preview")).textContent).toBe("p1/w1/line");
  });

  it("shows no preview for a widget with no chart to draw", () => {
    render(<ResourceCard model={model()} />);
    expect(screen.queryByTestId("preview")).toBeNull();
  });

  it("renders a detector's chips", () => {
    render(
      <ResourceCard
        model={model({
          resourceType: "detector",
          title: "Timeout failures",
          meta: ["Detector", "Failure"],
          body: { kind: "detector", chips: ["template prompt", "RCA on"] },
        })}
      />,
    );
    expect(screen.getByText("template prompt")).toBeTruthy();
    expect(screen.getByText("RCA on")).toBeTruthy();
  });

  it("renders a project receipt as label/value rows", () => {
    render(
      <ResourceCard
        model={model({
          resourceType: "project",
          title: "checkout-service",
          meta: ["Project"],
          body: {
            kind: "receipt",
            rows: [
              { label: "workspace", value: "ws1" },
              { label: "id", value: "p9" },
            ],
          },
        })}
      />,
    );
    expect(screen.getByText("workspace")).toBeTruthy();
    expect(screen.getByText("id")).toBeTruthy();
    expect(screen.getByText("p9")).toBeTruthy();
  });

  it("renders a dashboard's miniature grid from its tiles", () => {
    render(
      <ResourceCard
        model={model({
          resourceType: "dashboard",
          title: "Latency overview",
          meta: ["Dashboard", "2 widgets"],
          body: {
            kind: "dashboard",
            tiles: [
              { id: "w1", title: "p95", glyph: "line", x: 0, y: 0, w: 6, h: 4 },
              { id: "w2", title: "Recent", glyph: "trace_feed", x: 6, y: 0, w: 6, h: 6 },
            ],
          },
        })}
      />,
    );
    expect(screen.getByTestId("miniature").textContent).toBe("w1,w2");
  });

  it("keeps the header-only card for a dashboard with no widgets", () => {
    const { container } = render(
      <ResourceCard
        model={model({
          resourceType: "dashboard",
          title: "Latency overview",
          meta: ["Dashboard"],
          body: { kind: "dashboard", tiles: [] },
        })}
      />,
    );
    expect(screen.getByText("Latency overview")).toBeTruthy();
    expect(screen.queryByTestId("miniature")).toBeNull();
    expect(container.textContent).toBe("Latency overviewCreatedDashboard");
  });

  it("renders a body-less card when the arguments left nothing to show", () => {
    const { container } = render(
      <ResourceCard
        model={model({ title: "w1", body: { kind: "widget", chips: [], chart: null } })}
      />,
    );
    expect(container.textContent).toBe("w1CreatedWidget");
    expect(container.textContent).not.toContain("[object Object]");
  });

  it("does not print an empty receipt", () => {
    const { container } = render(
      <ResourceCard
        model={model({ resourceType: "project", body: { kind: "receipt", rows: [] } })}
      />,
    );
    expect(container.querySelectorAll("dl").length).toBe(0);
  });

  it("lets a long title and a long chip wrap instead of widening the card", () => {
    const { container } = render(
      <ResourceCard
        model={model({
          title: "A dashboard title long enough to need more than one line in a narrow panel",
          body: {
            kind: "widget",
            chips: ["by an_extremely_long_breakdown_dimension_name"],
            chart: null,
          },
        })}
      />,
    );
    const title = screen.getByText(/A dashboard title long enough/);
    expect(title.className).toContain("break-words");
    const chip = screen.getByText("by an_extremely_long_breakdown_dimension_name");
    expect(chip.className).toContain("whitespace-normal");
    expect(container.firstElementChild?.className).toContain("max-w-full");
  });
});
