// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { cloneElement, isValidElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/features/dashboards/api";
import { ROW_HEIGHT } from "@/features/dashboards/grid-constants";
import type { WidgetSpec } from "@/features/dashboards/types";
import { DEFAULT_SIZE } from "@/features/dashboards/widget-placement";
import { REFERENCE_COL_WIDTH } from "./dashboard-miniature";
import { WidgetChartPreview } from "./widget-chart-preview";

// The frame's shape, derived the way the dashboard miniature derives a tile's:
// a freshly placed chart widget's grid size at the reference proportions.
const TILE_ASPECT = `${DEFAULT_SIZE.query.w * REFERENCE_COL_WIDTH} / ${DEFAULT_SIZE.query.h * ROW_HEIGHT}`;

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1", email: "u@example.com" } }, isPending: false }),
}));
vi.mock("@/features/dashboards/api");

// jsdom reports 0x0 for the element recharts measures against, so
// ResponsiveContainer renders nothing. Stub it with a fixed-size div that,
// like the real one, clones the chart child with explicit width/height.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) => {
      const size = { width: 800, height: 400 };
      return (
        <div style={size}>{isValidElement(children) ? cloneElement(children, size) : children}</div>
      );
    },
  };
});

// jsdom has no IntersectionObserver; this one records every observed element
// so a test can decide when the card scrolls into view.
let observed: { element: Element; fire: () => void }[] = [];

class TestIntersectionObserver {
  constructor(private callback: IntersectionObserverCallback) {}
  observe(element: Element) {
    observed.push({
      element,
      fire: () =>
        this.callback(
          [{ isIntersecting: true, target: element } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        ),
    });
  }
  disconnect() {}
  unobserve() {}
}

const scrollIntoView = () => act(() => observed.forEach((o) => o.fire()));

const SPEC: WidgetSpec = {
  view: "spans",
  filters: [],
  metric: { measure: "total_tokens", agg: "sum" },
  breakdown: null,
  display: { type: "number" },
};

function renderPreview(spec: WidgetSpec = SPEC) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WidgetChartPreview projectId="p1" widgetId="w1" spec={spec} />
    </QueryClientProvider>,
  );
}

describe("WidgetChartPreview", () => {
  beforeEach(() => {
    observed = [];
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    vi.mocked(api.runWidgetQuery).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("issues no query for a card that has never been visible", () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: ["value"], rows: [[7]], meta: {} });
    renderPreview();
    expect(api.runWidgetQuery).not.toHaveBeenCalled();
    expect(observed).toHaveLength(1);
  });

  it("queries the widget's own spec once the card scrolls into view", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: ["value"], rows: [[7]], meta: {} });
    renderPreview();
    scrollIntoView();

    await waitFor(() => expect(screen.getByText("7")).toBeTruthy());
    expect(api.runWidgetQuery).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.runWidgetQuery).mock.calls[0][1]).toEqual(SPEC);
  });

  it("draws the chart the spec's display asks for", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({
      columns: ["bucket", "value"],
      rows: [
        ["2026-06-01T00:00:00", 1],
        ["2026-06-01T01:00:00", 4],
      ],
      meta: { granularity: "hour" },
    });
    const { container } = renderPreview({ ...SPEC, display: { type: "line" } });
    scrollIntoView();

    await waitFor(() => expect(container.querySelector("svg")).toBeTruthy());
  });

  it("queries the default dashboard window, ending no earlier than a day back", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: ["value"], rows: [[7]], meta: {} });
    renderPreview();
    scrollIntoView();

    await waitFor(() => expect(api.runWidgetQuery).toHaveBeenCalled());
    const range = vi.mocked(api.runWidgetQuery).mock.calls[0][2];
    expect(range.end.getTime() - range.start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("renders the chart's own empty state for a window with no rows", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: ["value"], rows: [], meta: {} });
    renderPreview();
    scrollIntoView();

    await waitFor(() => expect(screen.getByText("No data in range")).toBeTruthy());
    expect(screen.queryByText(/couldn't/i)).toBeNull();
  });

  it("keeps a failed query to a compact message inside the card", async () => {
    vi.mocked(api.runWidgetQuery).mockRejectedValue(new Error("clickhouse exploded"));
    const { container } = renderPreview();
    scrollIntoView();

    // The dashboard's query hook retries once before failing, so the message
    // lands a retry-backoff later than the other states.
    await waitFor(() => expect(screen.getByText(/couldn't load/i)).toBeTruthy(), { timeout: 5000 });
    expect(container.querySelector("svg")).toBeNull();
  });

  it("shows a placeholder, not an error, while the query is in flight", async () => {
    vi.mocked(api.runWidgetQuery).mockReturnValue(new Promise(() => {}));
    renderPreview();
    scrollIntoView();

    await waitFor(() => expect(screen.getByText("Loading…")).toBeTruthy());
  });

  it("frames the preview at a dashboard chart tile's own aspect ratio", () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: ["value"], rows: [[7]], meta: {} });
    const { container } = renderPreview();
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.style.aspectRatio).toBe(TILE_ASPECT);
    expect(frame.className).not.toContain("h-36");
  });

  it("keeps the loading state inside the same aspect frame", async () => {
    vi.mocked(api.runWidgetQuery).mockReturnValue(new Promise(() => {}));
    const { container } = renderPreview();
    scrollIntoView();

    await waitFor(() => expect(screen.getByText("Loading…")).toBeTruthy());
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.style.aspectRatio).toBe(TILE_ASPECT);
    expect(frame.contains(screen.getByText("Loading…"))).toBe(true);
  });

  it("keeps the empty state inside the same aspect frame", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: ["value"], rows: [], meta: {} });
    const { container } = renderPreview();
    scrollIntoView();

    await waitFor(() => expect(screen.getByText("No data in range")).toBeTruthy());
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.style.aspectRatio).toBe(TILE_ASPECT);
    expect(frame.contains(screen.getByText("No data in range"))).toBe(true);
  });

  it("keeps the error state inside the same aspect frame", async () => {
    vi.mocked(api.runWidgetQuery).mockRejectedValue(new Error("clickhouse exploded"));
    const { container } = renderPreview();
    scrollIntoView();

    await waitFor(() => expect(screen.getByText(/couldn't load/i)).toBeTruthy(), { timeout: 5000 });
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.style.aspectRatio).toBe(TILE_ASPECT);
    expect(frame.contains(screen.getByText(/couldn't load/i))).toBe(true);
  });
});
