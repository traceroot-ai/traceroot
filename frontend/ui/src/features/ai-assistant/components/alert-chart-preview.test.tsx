// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { DEFAULT_DATE_FILTER } from "@/lib/date-filter";
import type { AlertChart } from "../lib/resource-card";

const mocks = vi.hoisted(() => ({
  useWidgetPreview: vi.fn(),
  AlertPreviewChart: vi.fn(),
}));

vi.mock("@/features/dashboards/hooks/use-widget-data", () => ({
  useWidgetPreview: mocks.useWidgetPreview,
}));

// The chart itself is the alert form's, exercised in alert-preview.test.tsx;
// here it stands in for itself so the test can assert what the frame hands it.
vi.mock("@/features/alerts/components/alert-preview", () => ({
  MAX_PREVIEW_BUCKETS: 500,
  AlertPreviewChart: (props: unknown) => {
    mocks.AlertPreviewChart(props);
    return <div data-testid="chart" />;
  },
}));

import { AlertChartPreview } from "./alert-chart-preview";

// jsdom has no IntersectionObserver; the frame queries only once scrolled into view.
const observers: (() => void)[] = [];
const intersect = () => act(() => observers.forEach((fire) => fire()));

beforeEach(() => {
  observers.length = 0;
  mocks.useWidgetPreview.mockReset();
  mocks.AlertPreviewChart.mockReset();
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

const CHART: AlertChart = {
  view: "SPANS",
  measure: "latency",
  aggregation: "p95",
  window: "10m",
  operator: ">",
  threshold: 2000,
  filters: [{ field: "environment", op: "=", value: "production" }],
  projectId: "p1",
  range: DEFAULT_DATE_FILTER,
};

const DATA = {
  spec: {
    view: "spans",
    filters: [],
    metric: { measure: "duration_ms", agg: "p95" },
    breakdown: null,
    display: { type: "line" },
  },
  result: { columns: ["bucket", "value"], rows: [["2026-09-11T14:00:00", 1800]], meta: {} },
};

describe("AlertChartPreview", () => {
  it("queries nothing until the card has been on screen, then runs the rule's spec at its own bucket", () => {
    mocks.useWidgetPreview.mockReturnValue({ isPending: false, error: null, data: DATA });
    render(<AlertChartPreview chart={CHART} />);
    expect(mocks.useWidgetPreview).not.toHaveBeenCalled();

    intersect();
    expect(mocks.useWidgetPreview).toHaveBeenCalled();
    const [projectId, spec, range, bucketSeconds, options] = mocks.useWidgetPreview.mock.calls[0]!;
    expect(projectId).toBe("p1");
    // The alert form's own spec builder: the measure's engine field, the
    // rule's filters, a line over the range.
    expect(spec).toMatchObject({
      view: "spans",
      metric: { measure: "duration_ms", agg: "p95" },
      filters: [{ field: "environment", op: "=", value: "production" }],
      display: { type: "line" },
    });
    expect(range.end.getTime() - range.start.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(bucketSeconds).toBe(600);
    // A snapshot: frozen, never refetched on its own.
    expect(options).toEqual({
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    });
    expect(screen.getByTestId("chart")).toBeTruthy();
    expect(mocks.AlertPreviewChart).toHaveBeenCalledWith(
      expect.objectContaining({
        data: DATA,
        thresholdValue: 2000,
        operator: ">",
        bucketMs: 600_000,
      }),
    );
  });

  it("lets the server pick the grain when the window has too many of the rule's buckets", () => {
    mocks.useWidgetPreview.mockReturnValue({ isPending: false, error: null, data: DATA });
    render(
      <AlertChartPreview
        chart={{ ...CHART, window: "1m", range: { ...DEFAULT_DATE_FILTER, id: "7d" } }}
      />,
    );
    intersect();
    expect(mocks.useWidgetPreview.mock.calls[0]![3]).toBeUndefined();
  });

  it("says when the rule cannot be charted, when it is loading, and when the query failed", () => {
    mocks.useWidgetPreview.mockReturnValue({ isPending: true, error: null, data: undefined });
    const { unmount } = render(
      <AlertChartPreview chart={{ ...CHART, measure: "unique_user_ids", aggregation: "p95" }} />,
    );
    intersect();
    expect(screen.getByText("No preview available for this metric.")).toBeTruthy();
    unmount();

    render(<AlertChartPreview chart={CHART} />);
    intersect();
    expect(screen.getByText("Loading…")).toBeTruthy();
    cleanup();

    mocks.useWidgetPreview.mockReturnValue({
      isPending: false,
      error: new Error("clickhouse exploded"),
      data: undefined,
    });
    render(<AlertChartPreview chart={CHART} />);
    intersect();
    expect(screen.getByText("Couldn't load this preview").getAttribute("title")).toBe(
      "clickhouse exploded",
    );
  });
});
