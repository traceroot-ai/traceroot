// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { cloneElement, isValidElement } from "react";

// jsdom reports 0x0 for the container recharts measures against, so
// ResponsiveContainer renders nothing. Stub it with a fixed-size div that clones the child.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({
      children,
    }: {
      children:
        | React.ReactElement
        | ((size: { width: number; height: number }) => React.ReactElement);
    }) => {
      const size = { width: 800, height: 400 };
      const chart = typeof children === "function" ? children(size) : children;
      return (
        <div style={{ width: size.width, height: size.height }}>
          {isValidElement(chart) ? cloneElement(chart, size) : chart}
        </div>
      );
    },
  };
});

const mocks = vi.hoisted(() => ({
  useWidgetPreview: vi.fn(),
}));

vi.mock("@/features/dashboards/hooks/use-widget-data", () => ({
  useWidgetPreview: mocks.useWidgetPreview,
}));

import { AlertPreview } from "./alert-preview";
import { QueryWidgetRenderer } from "@/features/dashboards/components/renderers";

type PreviewOverrides = Partial<React.ComponentProps<typeof AlertPreview>>;

function renderPreview(overrides: PreviewOverrides = {}) {
  return render(
    <AlertPreview
      projectId="proj-1"
      view="SPANS"
      measureId="latency"
      aggregation="p95"
      operator=">"
      threshold=""
      window="10m"
      {...overrides}
    />,
  );
}

function stubPreview(agg: string, result: unknown) {
  mocks.useWidgetPreview.mockReturnValue({
    isPending: false,
    error: null,
    data: {
      spec: {
        view: "spans",
        filters: [],
        metric: { measure: "count", agg },
        breakdown: null,
        display: { type: "line" },
      },
      result,
    },
  });
}

// One bucket in the middle reported nothing: zero for an additive aggregation, else no value.
const GAPPY_RESULT = {
  columns: ["bucket", "value"],
  rows: [
    ["2026-08-10T10:00:00", 120],
    ["2026-08-10T11:00:00", null],
    ["2026-08-10T12:00:00", 90],
  ],
  meta: { granularity: "hour" as const },
};

const DENSE_RESULT = {
  columns: ["bucket", "value"],
  rows: [
    ["2026-08-10T10:00:00", 120],
    ["2026-08-10T11:00:00", 105],
    ["2026-08-10T12:00:00", 90],
  ],
  meta: { granularity: "hour" as const },
};

function curvesIn(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".recharts-line-curve")).map(
    (c) => c.getAttribute("d") ?? "",
  );
}

function strokeCount(curves: string[]): number {
  return curves.join(" ").match(/M/g)?.length ?? 0;
}

function previewGeometry(agg: string, result: unknown = GAPPY_RESULT) {
  stubPreview(agg, result);
  const { container, unmount } = renderPreview({ measureId: "count", aggregation: "count" });
  const geometry = {
    curves: curvesIn(container),
    dots: container.querySelectorAll(".recharts-line-dots circle").length,
  };
  unmount();
  return geometry;
}

function previewCurve(agg: string, result: unknown = GAPPY_RESULT): string[] {
  return previewGeometry(agg, result).curves;
}

function dashboardCurve(agg: string): string[] {
  const { container, unmount } = render(
    <QueryWidgetRenderer display="line" result={GAPPY_RESULT} agg={agg as never} />,
  );
  const paths = curvesIn(container);
  unmount();
  return paths;
}

describe("empty buckets across the alert preview and the dashboard", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("gives an aggregation neither surface has heard of the same treatment on both", () => {
    // An agg nobody lists must not break on one surface and bridge on the other.
    expect(previewCurve("stddev")).toEqual(dashboardCurve("stddev"));
    expect(dashboardCurve("stddev")).toEqual(dashboardCurve("count"));

    // The agreement above is between real curves, not two identical blanks.
    expect(previewCurve("count", DENSE_RESULT)).not.toEqual(previewCurve("count"));
  });
});

describe("AlertPreview", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("breaks the line at an empty bucket whatever the aggregation, and dots what that strands", () => {
    // Two strokes over three buckets: the empty one is a break, not a straight descent.
    expect(strokeCount(previewCurve("count"))).toBe(2);
    expect(strokeCount(previewCurve("count", DENSE_RESULT))).toBe(1);
    // A percentile is the aggregation the dashboard bridges; the preview does not.
    expect(previewCurve("p95")).toEqual(previewCurve("count"));

    expect(previewGeometry("p95").dots).toBe(2);
    expect(previewGeometry("p95", DENSE_RESULT).dots).toBe(0);
  });

  it("shows the unavailable state for a combination the engine cannot run", () => {
    mocks.useWidgetPreview.mockReturnValue({ isPending: true, error: null, data: undefined });
    // count on a numeric column: the engine reserves count for its count(*) sentinel.
    renderPreview({ measureId: "latency", aggregation: "count" });

    expect(screen.getByText("No preview available for this metric yet.")).toBeTruthy();
    expect(mocks.useWidgetPreview.mock.calls[0][1]).toBeNull();
  });

  it("shows loading and error states honestly", () => {
    mocks.useWidgetPreview.mockReturnValue({ isPending: true, error: null, data: undefined });
    renderPreview();
    expect(screen.getByText("Running...")).toBeTruthy();
    cleanup();

    mocks.useWidgetPreview.mockReturnValue({
      isPending: false,
      error: new Error("boom"),
      data: undefined,
    });
    renderPreview();
    expect(screen.getByText("Preview failed to load.")).toBeTruthy();
  });
});
