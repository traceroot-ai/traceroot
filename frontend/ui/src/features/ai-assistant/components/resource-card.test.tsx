// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DATE_FILTER_OPTIONS } from "@/lib/date-filter";
import { ResourceCard } from "./resource-card";
import type { MiniatureTile, ResourceCardModel, WidgetChart } from "../lib/resource-card";

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

const TILES: MiniatureTile[] = [
  { id: "w1", title: "p95", glyph: "line", chart: null, x: 0, y: 0, w: 6, h: 4 },
  { id: "w2", title: "Recent", glyph: "trace_feed", chart: null, x: 6, y: 0, w: 6, h: 6 },
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

  it("hides and shows a dashboard's miniature the same way", () => {
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
    expect(screen.getByTestId("miniature").textContent).toBe("w1,w2");
    fireEvent.click(screen.getByRole("button", { name: "Hide preview" }));
    expect(screen.queryByTestId("miniature")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show preview" }));
    expect(screen.getByTestId("miniature")).toBeTruthy();
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

  it("renders a dashboard's miniature grid from its tiles", () => {
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
    expect(screen.getByTestId("miniature").textContent).toBe("w1,w2");
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
    expect(screen.queryByTestId("miniature")).toBeNull();
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
