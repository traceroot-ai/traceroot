// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DATE_FILTER_OPTIONS } from "@/lib/date-filter";
import { ResourceCard } from "./resource-card";
import type { ResourceCardModel, WidgetChart } from "../lib/resource-card";

// The preview is exercised for real in widget-chart-preview.test.tsx; here it
// stands in for itself so these tests can assert what the card hands it.
vi.mock("./widget-chart-preview", () => ({
  WidgetChartPreview: ({
    projectId,
    widgetId,
    spec,
    rangeId,
  }: Omit<WidgetChart, "range"> & { widgetId: string; rangeId: string }) => (
    <div data-testid="preview">{`${projectId}/${widgetId}/${spec.display.type}/${rangeId}`}</div>
  ),
}));

// Same for the miniature, exercised for real in dashboard-miniature.test.tsx.
// Partial: the module also exports the chart tile aspect the card's dynamic
// loading placeholder frames itself with, and that must stay real.
vi.mock("./dashboard-miniature", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dashboard-miniature")>()),
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
  range: DATE_FILTER_OPTIONS.find((o) => o.id === "7d")!,
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
  it("heads a created resource with its name and meta line, and no badge", () => {
    render(<ResourceCard model={model()} />);
    expect(screen.getByText("Tokens by model")).toBeTruthy();
    expect(screen.getByText("Widget")).toBeTruthy();
    expect(screen.queryByText("Created")).toBeNull();
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
    // The card hands the preview the range it snapshotted, so the header's
    // label and the plot's window cannot come apart.
    expect((await screen.findByTestId("preview")).textContent).toBe("p1/w1/line/7d");
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
          body: { kind: "detector", chips: ["sample 25%", "RCA on"], prompt: null },
        })}
      />,
    );
    expect(screen.getByText("sample 25%")).toBeTruthy();
    expect(screen.getByText("RCA on")).toBeTruthy();
  });

  it("names the standard prompt a detector runs when the args carried none", () => {
    render(
      <ResourceCard
        model={model({
          resourceType: "detector",
          title: "Timeout failures",
          meta: ["Detector", "Failure"],
          body: {
            kind: "detector",
            chips: [],
            prompt: { kind: "standard", templateLabel: "Failure" },
          },
        })}
      />,
    );
    expect(screen.getByText("Uses the standard Failure prompt")).toBeTruthy();
  });

  it("shows a short custom prompt whole, with no toggle", () => {
    render(
      <ResourceCard
        model={model({
          resourceType: "detector",
          title: "Timeouts",
          meta: ["Detector", "Custom"],
          body: {
            kind: "detector",
            chips: [],
            prompt: { kind: "custom", text: "Only report a timeout past 30 seconds." },
          },
        })}
      />,
    );
    expect(screen.getByText("Only report a timeout past 30 seconds.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("clamps a long custom prompt behind a show-more toggle", () => {
    const text = Array.from({ length: 12 }, (_, i) => `rule ${i}: check the span`).join("\n");
    const { container } = render(
      <ResourceCard
        model={model({
          resourceType: "detector",
          title: "Timeouts",
          meta: ["Detector", "Custom"],
          body: { kind: "detector", chips: [], prompt: { kind: "custom", text } },
        })}
      />,
    );
    const block = container.querySelector("pre");
    expect(block?.textContent).toBe(text);
    expect(block?.className).toContain("line-clamp");
    const toggle = screen.getByRole("button", { name: "Show more" });
    fireEvent.click(toggle);
    expect(container.querySelector("pre")?.className).not.toContain("line-clamp");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(container.querySelector("pre")?.className).toContain("line-clamp");
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
              { id: "w1", title: "p95", glyph: "line", chart: null, x: 0, y: 0, w: 6, h: 4 },
              {
                id: "w2",
                title: "Recent",
                glyph: "trace_feed",
                chart: null,
                x: 6,
                y: 0,
                w: 6,
                h: 6,
              },
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
    expect(container.textContent).toBe("Latency overviewDashboard");
  });

  it("renders a body-less card when the arguments left nothing to show", () => {
    const { container } = render(
      <ResourceCard
        model={model({ title: "w1", body: { kind: "widget", chips: [], chart: null } })}
      />,
    );
    expect(container.textContent).toBe("w1Widget");
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
