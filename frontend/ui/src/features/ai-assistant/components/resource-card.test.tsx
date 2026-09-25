// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DATE_FILTER_OPTIONS, DEFAULT_DATE_FILTER } from "@/lib/date-filter";
import { ResourceCard } from "./resource-card";
import type { AlertChart, PreviewTile, ResourceCardModel, WidgetChart } from "../lib/resource-card";

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

// And the alert chart, exercised for real in alert-chart-preview.test.tsx.
vi.mock("./alert-chart-preview", () => ({
  AlertChartPreview: ({ chart }: { chart: AlertChart }) => (
    <div data-testid="alert-preview">{`${chart.projectId}/${chart.aggregation}(${chart.measure})/${chart.operator}${chart.threshold}/${chart.range.id}`}</div>
  ),
}));

// Same for the dashboard preview, exercised for real in dashboard-preview.test.tsx.
vi.mock("./dashboard-preview", () => ({
  DashboardPreview: ({ tiles }: { tiles: { id: string }[] }) => (
    <div data-testid="preview-grid">{tiles.map((t) => t.id).join(",")}</div>
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

const TILES: PreviewTile[] = [
  {
    id: "w1",
    title: "p95",
    projectId: "p1",
    widget: { type: "query", spec: {} },
    range: DEFAULT_DATE_FILTER,
    x: 0,
    y: 0,
    w: 6,
    h: 4,
  },
  {
    id: "w2",
    title: "Recent",
    projectId: "p1",
    widget: { type: "trace_feed", spec: {} },
    range: DEFAULT_DATE_FILTER,
    x: 6,
    y: 0,
    w: 6,
    h: 6,
  },
];

function model(overrides: Partial<ResourceCardModel> = {}): ResourceCardModel {
  return {
    resourceType: "widget",
    resourceId: "w1",
    created: true,
    title: "Tokens by model",
    meta: ["Widget"],
    href: null,
    body: { kind: "widget", chips: ["view spans", "sum(total_tokens)"], chart: null },
    ...overrides,
  };
}

/** The footer's definition toggle — the card's title, as a button. */
const definitionToggle = (title: string) => screen.getByRole("button", { name: title });

describe("ResourceCard footer", () => {
  it("names the resource in the footer and shows its meta, with no badge for a fresh create", () => {
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

  it("offers no create or skip buttons — a receipt is not a prompt", () => {
    const { container } = render(<ResourceCard model={model()} />);
    expect(screen.queryByRole("button", { name: /create|skip/i })).toBeNull();
    expect(container.textContent).not.toContain("Awaiting");
  });

  it("joins the meta parts into one line", () => {
    render(<ResourceCard model={model({ meta: ["Dashboard", "2 widgets"] })} />);
    expect(screen.getByText("Dashboard · 2 widgets")).toBeTruthy();
  });

  it("leads the meta with Proposed on a card for a write that has not run", () => {
    render(<ResourceCard model={model({ meta: ["Widget", "Last 24 hours"] })} proposed />);
    expect(screen.getByText("Proposed · Widget · Last 24 hours")).toBeTruthy();
  });

  it("truncates a long title instead of pushing the actions out of the footer", () => {
    render(
      <ResourceCard
        model={model({
          title: "A dashboard title long enough to need more than one line in a narrow panel",
        })}
      />,
    );
    const title = screen.getByText(/A dashboard title long enough/);
    expect(title.className).toContain("truncate");
    expect(title.closest("button")?.className).toContain("min-w-0");
  });
});

describe("ResourceCard definition panel", () => {
  it("keeps a widget's spec chips behind the title until it is clicked", () => {
    render(<ResourceCard model={model()} />);
    const toggle = definitionToggle("Tokens by model");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("view spans")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("view spans")).toBeTruthy();
    expect(screen.getByText("sum(total_tokens)")).toBeTruthy();

    fireEvent.click(toggle);
    expect(screen.queryByText("view spans")).toBeNull();
  });

  it("reveals a detector's settings chips, keeping its prompt as the body", () => {
    render(
      <ResourceCard
        model={model({
          resourceType: "detector",
          title: "Timeout failures",
          meta: ["Detector", "Failure"],
          body: {
            kind: "detector",
            chips: ["sample 25%", "RCA on"],
            prompt: { kind: "standard", templateLabel: "Failure" },
          },
        })}
      />,
    );
    // The prompt is what the detector IS, so it stays in view.
    expect(screen.getByText("Uses the standard Failure prompt")).toBeTruthy();
    expect(screen.queryByText("sample 25%")).toBeNull();
    fireEvent.click(definitionToggle("Timeout failures"));
    expect(screen.getByText("sample 25%")).toBeTruthy();
    expect(screen.getByText("RCA on")).toBeTruthy();
  });

  it("reveals an alert's rule chips and its facts, keeping the badge and chart out of the panel", () => {
    render(
      <ResourceCard
        model={model({
          resourceType: "alert",
          title: "p95 latency over 2s",
          meta: ["Alert", "Last 24 hours"],
          badge: {
            status: "ACTIVE",
            severity: "OK",
            lastError: null,
            lastEvaluatedAt: "2026-09-11T14:48:00Z",
            lastNotifyStatus: null,
            lastNotifyError: null,
          },
          facts: [{ label: "last evaluated", value: "2026-09-11 14:48:00" }],
          body: {
            kind: "alert",
            chips: ["view spans", "p95(latency)", "> 2,000 ms", "renotify off"],
            chart: null,
          },
        })}
      />,
    );
    // The alerts page's own badge sits in the footer whatever the panel does.
    expect(screen.getByText("OK")).toBeTruthy();
    expect(screen.queryByText("renotify off")).toBeNull();
    fireEvent.click(definitionToggle("p95 latency over 2s"));
    expect(screen.getByText("p95(latency)")).toBeTruthy();
    expect(screen.getByText("renotify off")).toBeTruthy();
    expect(screen.getByText("last evaluated")).toBeTruthy();
    expect(screen.getByText("2026-09-11 14:48:00")).toBeTruthy();
  });

  it("opens the definition panel with the card when the model says so — a read's answer is its definition", () => {
    render(
      <ResourceCard
        model={model({
          resourceType: "alert",
          title: "Error rate spike",
          meta: ["Alert"],
          definitionOpen: true,
          facts: [{ label: "alerting since", value: "2026-09-11 14:35:00" }],
          body: { kind: "alert", chips: ["≥ 25"], chart: null },
        })}
      />,
    );
    expect(screen.getByText("≥ 25")).toBeTruthy();
    expect(screen.getByText("alerting since")).toBeTruthy();
    expect(definitionToggle("Error rate spike").getAttribute("aria-expanded")).toBe("true");
  });

  it("badges a proposal only when its model carries a state — an edit of a live alert", () => {
    render(
      <ResourceCard
        proposed
        model={model({
          resourceType: "alert",
          title: "p95 latency",
          meta: ["Alert"],
          badge: {
            status: "ACTIVE",
            severity: "ALERT",
            lastError: null,
            lastEvaluatedAt: "2026-09-17T09:05:00Z",
            lastNotifyStatus: null,
            lastNotifyError: null,
          },
          body: { kind: "changes", chips: ["threshold: 2000 → 3000"], preview: null },
        })}
      />,
    );
    // The alerts page's own label for a firing rule, in the footer.
    expect(screen.getByText("Alert", { selector: "span" })).toBeTruthy();
  });

  it("never badges a create proposal: an alert that does not exist has no state", () => {
    // pendingCardModel never sets a badge on a create; the card shows none
    // without one, whatever the alert's future state might be.
    render(
      <ResourceCard
        proposed
        model={model({
          resourceType: "alert",
          title: "p95 latency over 2s",
          meta: ["Alert"],
          body: { kind: "alert", chips: [], chart: null },
        })}
      />,
    );
    expect(screen.queryByText("OK")).toBeNull();
    expect(screen.queryByText("No Data")).toBeNull();
    expect(screen.getByText("Proposed · Alert")).toBeTruthy();
  });

  it("stands an alert with no chart and no chips on its footer alone", () => {
    render(
      <ResourceCard
        model={model({
          resourceType: "alert",
          title: "al1",
          meta: ["Alert"],
          href: "/projects/p1/alerts/al1",
          body: { kind: "alert", chips: [], chart: null },
        })}
      />,
    );
    expect(screen.getByText("al1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "al1" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open alert" }).getAttribute("href")).toBe(
      "/projects/p1/alerts/al1",
    );
  });

  it("reveals the description a reused dashboard carries", () => {
    render(
      <ResourceCard
        model={model({
          resourceType: "dashboard",
          title: "Latency overview",
          meta: ["Dashboard", "1 widget"],
          created: false,
          description: "Where the time goes",
          body: { kind: "dashboard", tiles: [] },
        })}
      />,
    );
    expect(screen.queryByText("Where the time goes")).toBeNull();
    fireEvent.click(definitionToggle("Latency overview"));
    expect(screen.getByText("Where the time goes")).toBeTruthy();
  });

  it("lets a long chip wrap inside the panel instead of widening the card", () => {
    const { container } = render(
      <ResourceCard
        model={model({
          body: {
            kind: "widget",
            chips: ["by an_extremely_long_breakdown_dimension_name"],
            chart: null,
          },
        })}
      />,
    );
    fireEvent.click(definitionToggle("Tokens by model"));
    const chip = screen.getByText("by an_extremely_long_breakdown_dimension_name");
    expect(chip.className).toContain("whitespace-normal");
    expect(container.firstElementChild?.className).toContain("max-w-full");
  });

  it("makes the title plain text when there is nothing to reveal", () => {
    const { container } = render(
      <ResourceCard
        model={model({ title: "w1", body: { kind: "widget", chips: [], chart: null } })}
      />,
    );
    expect(screen.queryByRole("button", { name: "w1" })).toBeNull();
    expect(container.textContent).toBe("w1Widget");
    expect(container.textContent).not.toContain("[object Object]");
  });
});

describe("ResourceCard open link", () => {
  it("opens the resource's page from the footer", () => {
    render(<ResourceCard model={model({ href: "/projects/p1/dashboard/db1" })} />);
    // The accessible name says what opens, since the footer row reads as a list.
    const link = screen.getByRole("link", { name: "Open widget" });
    expect(link.getAttribute("href")).toBe("/projects/p1/dashboard/db1");
  });

  it("links a detector to its own page", () => {
    render(
      <ResourceCard
        model={model({
          resourceType: "detector",
          title: "Timeouts",
          meta: ["Detector"],
          href: "/projects/p1/detectors/d1",
          body: { kind: "detector", chips: [], prompt: null },
        })}
      />,
    );
    expect(screen.getByRole("link", { name: "Open detector" }).getAttribute("href")).toBe(
      "/projects/p1/detectors/d1",
    );
  });

  it("offers no link when the model has no page to open", () => {
    render(
      <ResourceCard
        model={model({
          resourceType: "project",
          title: "checkout-service",
          meta: ["Project"],
          body: { kind: "receipt", rows: [{ label: "id", value: "p9" }] },
        })}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("ResourceCard body", () => {
  it("draws the created widget's own chart as the body, above the footer", async () => {
    render(
      <ResourceCard
        model={model({ body: { kind: "widget", chips: ["view spans"], chart: CHART } })}
      />,
    );
    // findBy: the preview module is loaded through next/dynamic, so the stub
    // mounts a tick after the card renders.
    const preview = await screen.findByTestId("preview");
    // The card hands the preview the range it snapshotted, so the header's
    // label and the plot's window cannot come apart.
    expect(preview.textContent).toBe("p1/w1/line/7d");
    const title = screen.getByText("Tokens by model");
    expect(preview.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws an alert's chart as the body and lets the footer hide it", async () => {
    const chart: AlertChart = {
      view: "SPANS",
      measure: "latency",
      aggregation: "p95",
      window: "10m",
      operator: ">",
      threshold: 2000,
      filters: [],
      projectId: "p1",
      range: DATE_FILTER_OPTIONS.find((o) => o.id === "7d")!,
    };
    render(
      <ResourceCard
        model={model({
          resourceType: "alert",
          title: "p95 latency over 2s",
          meta: ["Alert", "Last 7 days"],
          body: { kind: "alert", chips: [], chart },
        })}
      />,
    );
    // The chart loads through next/dynamic, so it lands a tick later.
    expect((await screen.findByTestId("alert-preview")).textContent).toBe(
      "p1/p95(latency)/>2000/7d",
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide preview" }));
    expect(screen.queryByTestId("alert-preview")).toBeNull();
    expect(screen.getByText("p95 latency over 2s")).toBeTruthy();
  });

  it("shows no preview for a widget with no chart to draw", () => {
    render(<ResourceCard model={model()} />);
    expect(screen.queryByTestId("preview")).toBeNull();
  });

  it("hides and shows a widget's chart from the footer, keeping the footer itself", async () => {
    render(
      <ResourceCard
        model={model({ body: { kind: "widget", chips: ["view spans"], chart: CHART } })}
      />,
    );
    await screen.findByTestId("preview");
    fireEvent.click(screen.getByRole("button", { name: "Hide preview" }));
    expect(screen.queryByTestId("preview")).toBeNull();
    expect(screen.getByText("Tokens by model")).toBeTruthy();
    expect(screen.getByText("Widget")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show preview" }));
    expect(await screen.findByTestId("preview")).toBeTruthy();
  });

  it("hides and shows a dashboard's preview the same way", () => {
    render(
      <ResourceCard
        model={model({
          resourceType: "dashboard",
          title: "Latency overview",
          meta: ["Dashboard", "2 widgets"],
          body: { kind: "dashboard", tiles: TILES },
        })}
      />,
    );
    expect(screen.getByTestId("preview-grid").textContent).toBe("w1,w2");
    fireEvent.click(screen.getByRole("button", { name: "Hide preview" }));
    expect(screen.queryByTestId("preview-grid")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show preview" }));
    expect(screen.getByTestId("preview-grid")).toBeTruthy();
  });

  it("offers no hide toggle when the body has nothing to picture", () => {
    render(<ResourceCard model={model()} />);
    expect(screen.queryByRole("button", { name: /preview/ })).toBeNull();
    render(
      <ResourceCard
        model={model({
          resourceType: "detector",
          title: "Timeouts",
          meta: ["Detector"],
          body: { kind: "detector", chips: [], prompt: { kind: "custom", text: "Flag it." } },
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: /preview/ })).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
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

  it("renders a dashboard's scaled-down preview from its tiles", () => {
    render(
      <ResourceCard
        model={model({
          resourceType: "dashboard",
          title: "Latency overview",
          meta: ["Dashboard", "2 widgets"],
          body: { kind: "dashboard", tiles: TILES },
        })}
      />,
    );
    expect(screen.getByTestId("preview-grid").textContent).toBe("w1,w2");
  });

  it("keeps the footer-only card for a dashboard with no widgets", () => {
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
    expect(screen.queryByTestId("preview-grid")).toBeNull();
    expect(container.textContent).toBe("Latency overviewDashboard");
  });

  it("does not print an empty receipt", () => {
    const { container } = render(
      <ResourceCard
        model={model({ resourceType: "project", body: { kind: "receipt", rows: [] } })}
      />,
    );
    expect(container.querySelectorAll("dl").length).toBe(0);
  });
});

describe("ResourceCard edits and deletes", () => {
  it("shows an edit's change chips in the body, open from the start, under its preview", async () => {
    render(
      <ResourceCard
        proposed
        model={model({
          title: "Tokens by model",
          meta: ["Widget", "Last 7 days"],
          definitionOpen: true,
          body: {
            kind: "changes",
            chips: [
              "title: Tokens → Tokens by model",
              "spec: view spans · sum(total_tokens) · line",
            ],
            preview: { kind: "widget", chart: CHART },
          },
        })}
      />,
    );
    // The preview loads through next/dynamic, so it lands a tick later.
    expect((await screen.findByTestId("preview")).textContent).toBe("p1/w1/line/7d");
    expect(screen.getByText("title: Tokens → Tokens by model")).toBeTruthy();
    expect(screen.getByText("spec: view spans · sum(total_tokens) · line")).toBeTruthy();
    expect(screen.getByText("Proposed · Widget · Last 7 days")).toBeTruthy();
  });

  it("previews a detector's new prompt and an alert's edited rule the same way the creates do", async () => {
    const { unmount } = render(
      <ResourceCard
        model={model({
          resourceType: "detector",
          title: "Timeouts",
          meta: ["Detector"],
          body: {
            kind: "changes",
            chips: ["prompt: replaced"],
            preview: { kind: "prompt", prompt: { kind: "custom", text: "Flag slow traces." } },
          },
        })}
      />,
    );
    expect(screen.getByText("Flag slow traces.")).toBeTruthy();
    unmount();

    render(
      <ResourceCard
        model={model({
          resourceType: "alert",
          title: "p95 latency",
          meta: ["Alert"],
          body: {
            kind: "changes",
            chips: ["threshold: 2000 → 3000"],
            preview: {
              kind: "alert",
              chart: {
                projectId: "p1",
                view: "SPANS",
                measure: "latency",
                aggregation: "p95",
                window: "10m",
                operator: ">",
                threshold: 3000,
                filters: [],
                range: DEFAULT_DATE_FILTER,
              },
            },
          },
        })}
      />,
    );
    expect((await screen.findByTestId("alert-preview")).textContent).toBe(
      `p1/p95(latency)/>3000/${DEFAULT_DATE_FILTER.id}`,
    );
  });

  it("offers to hide a chart preview on an edit, like a create's", () => {
    render(
      <ResourceCard
        model={model({
          body: { kind: "changes", chips: [], preview: { kind: "widget", chart: CHART } },
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide preview" }));
    expect(screen.queryByTestId("preview")).toBeNull();
  });

  it("renders a delete proposal destructively: the reason quoted as the body, the cascade, the chips", () => {
    const { container } = render(
      <ResourceCard
        proposed
        model={model({
          resourceType: "dashboard",
          title: "Test alpha",
          meta: ["Dashboard"],
          destructive: true,
          definitionOpen: true,
          body: {
            kind: "delete",
            reason: "the user asked to clean up the test dashboards",
            cascade: "and its 4 widgets",
            chips: ["view spans"],
          },
        })}
      />,
    );
    expect(screen.getByText("“the user asked to clean up the test dashboards”")).toBeTruthy();
    expect(screen.getByText("and its 4 widgets")).toBeTruthy();
    expect(screen.getByText("view spans")).toBeTruthy();
    expect(screen.getByText("Proposed · Dashboard")).toBeTruthy();
    expect(container.firstElementChild?.className).toContain("border-destructive");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("labels an update receipt Updated and a delete receipt Deleted, with no destructive border", () => {
    const { container, unmount } = render(
      <ResourceCard
        model={model({
          outcome: "updated",
          href: "/projects/p1/dashboard/db1",
          body: { kind: "changes", chips: ["title: Errors"], preview: null },
        })}
      />,
    );
    expect(screen.getByText("Updated")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open widget" })).toBeTruthy();
    expect(container.firstElementChild?.className).not.toContain("border-destructive");
    unmount();

    render(
      <ResourceCard
        model={model({
          outcome: "deleted",
          body: { kind: "delete", reason: "duplicate", cascade: null, chips: [] },
        })}
      />,
    );
    expect(screen.getByText("Deleted")).toBeTruthy();
    expect(screen.getByText("“duplicate”")).toBeTruthy();
    expect(screen.queryByText("Reused")).toBeNull();
  });

  it("keeps an edit with no chips and no preview on its footer alone", () => {
    const { container } = render(
      <ResourceCard model={model({ body: { kind: "changes", chips: [], preview: null } })} />,
    );
    expect(container.querySelectorAll(".border-t").length).toBe(0);
    expect(screen.queryByRole("button", { name: "Hide preview" })).toBeNull();
  });
});
