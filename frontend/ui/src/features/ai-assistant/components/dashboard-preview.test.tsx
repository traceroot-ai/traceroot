// @vitest-environment jsdom
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { cloneElement, isValidElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/features/dashboards/api";
import { COLS, ROW_HEIGHT } from "@/features/dashboards/grid-constants";
import { quantizeRange } from "@/features/dashboards/hooks/use-widget-data";
import type { TimeRange } from "@/features/dashboards/types";
import { DashboardPreview, REFERENCE_WIDTH, gridHeight, tileFrame } from "./dashboard-preview";
import { REFERENCE_COL_WIDTH } from "./preview-constants";
import { DATE_FILTER_OPTIONS, DEFAULT_DATE_FILTER } from "@/lib/date-filter";
import type { PreviewTile } from "../lib/resource-card";

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1", email: "u@example.com" } }, isPending: false }),
}));
vi.mock("@/features/dashboards/api");

// The feed is exercised for real in its own tests; here it stands in for
// itself so a feed tile can be told apart from a chart tile.
vi.mock("@/features/dashboards/components/TraceFeedWidget", () => ({
  TraceFeedWidget: ({ projectId, range }: { projectId: string; range: TimeRange }) => (
    <div data-testid="trace-feed">
      {projectId}:{range.start.getTime()}-{range.end.getTime()}
    </div>
  ),
}));

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
// so a test can decide when the preview scrolls into view.
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

// jsdom lays nothing out, so the wrapper's width is whatever a test says.
let wrapperWidth = 0;
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get: () => wrapperWidth,
});

const SPEC = {
  view: "spans",
  filters: [],
  metric: { measure: "total_tokens", agg: "sum" },
  breakdown: null,
  display: { type: "number" },
};

function tile(overrides: Partial<PreviewTile> = {}): PreviewTile {
  return {
    id: "w1",
    title: "Tokens",
    projectId: "p1",
    widget: { type: "query", spec: SPEC },
    range: DEFAULT_DATE_FILTER,
    x: 0,
    y: 0,
    w: 6,
    h: 4,
    ...overrides,
  };
}

const FEED = tile({
  id: "w2",
  title: "Recent traces",
  widget: { type: "trace_feed", spec: { limit: 10 } },
  x: 6,
  h: 6,
});

function renderPreview(tiles: PreviewTile[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = () => (
    <QueryClientProvider client={client}>
      <DashboardPreview tiles={tiles} />
    </QueryClientProvider>
  );
  const result = render(ui());
  const wrapper = result.container.firstElementChild as HTMLElement;
  const grid = wrapper.firstElementChild as HTMLElement;
  return { client, wrapper, grid, ...result, rerenderPreview: () => result.rerender(ui()) };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  wrapperWidth = 0;
});

describe("preview geometry", () => {
  // react-grid-layout's own arithmetic, for a grid at the reference width
  // with its default ten-pixel margin and padding: this is what the real
  // dashboard computes for the same layout, so the preview must match it.
  const margin = 10;
  const colWidth = (REFERENCE_WIDTH - margin * (COLS - 1) - margin * 2) / COLS;

  it("derives the reference width from the grid's columns at the reference column width", () => {
    expect(colWidth).toBe(REFERENCE_COL_WIDTH);
  });

  it("positions a 6x4 tile at the origin and its right-hand neighbour where the grid would", () => {
    const width = Math.round(colWidth * 6 + 5 * margin);
    const height = Math.round(ROW_HEIGHT * 4 + 3 * margin);
    expect(tileFrame(tile())).toEqual({ left: margin, top: margin, width, height });
    expect(tileFrame(tile({ x: 6 }))).toEqual({
      left: Math.round((colWidth + margin) * 6 + margin),
      top: margin,
      width,
      height,
    });
  });

  it("sizes the grid to its lowest tile, margins and padding included, like the grid's container", () => {
    const rows = 8;
    expect(gridHeight([tile(), tile({ id: "w2", y: 4 })])).toBe(
      rows * ROW_HEIGHT + (rows - 1) * margin + margin * 2,
    );
  });
});

describe("DashboardPreview", () => {
  beforeEach(() => {
    observed = [];
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    vi.mocked(api.runWidgetQuery).mockReset();
  });

  it("renders one real tile per widget, titled, without the dashboard's handle or menu", () => {
    const { grid } = renderPreview([tile(), FEED]);
    const tiles = grid.querySelectorAll("[data-preview-tile]");
    expect(tiles).toHaveLength(2);
    expect(screen.getByText("Tokens").className).toContain("truncate");
    expect(screen.getByText("Recent traces")).toBeTruthy();
    expect(grid.querySelectorAll("button")).toHaveLength(0);
    expect(grid.querySelector(".drag-handle")).toBeNull();
  });

  it("places each tile at its grid frame, in a grid of the reference size", () => {
    const { grid } = renderPreview([tile(), FEED]);
    expect(grid.style.width).toBe(`${REFERENCE_WIDTH}px`);
    expect(grid.style.height).toBe(`${gridHeight([tile(), FEED])}px`);
    const [first, second] = [...grid.querySelectorAll<HTMLElement>("[data-preview-tile]")];
    const frame = tileFrame(FEED);
    expect(first.style.left).toBe(`${tileFrame(tile()).left}px`);
    expect(second.style.left).toBe(`${frame.left}px`);
    expect(second.style.width).toBe(`${frame.width}px`);
    expect(second.style.height).toBe(`${frame.height}px`);
  });

  it("scales the grid to the wrapper's width and reserves the scaled height", () => {
    wrapperWidth = 300;
    const { wrapper, grid } = renderPreview([tile(), FEED]);
    expect(grid.style.transform).toBe(`scale(${300 / REFERENCE_WIDTH})`);
    expect(grid.style.transformOrigin).toBe("top left");
    // Height as a ratio of the width: exactly gridHeight * scale, and known
    // before any measurement, so the transcript never jumps.
    expect(wrapper.style.aspectRatio).toBe(`${REFERENCE_WIDTH} / ${gridHeight([tile(), FEED])}`);
    expect(wrapper.className).toContain("overflow-hidden");
  });

  it("rescales when the wrapper is resized", () => {
    let resize: (() => void) | null = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: () => void) {}
        observe() {
          resize = this.callback;
        }
        disconnect() {}
      },
    );
    wrapperWidth = 300;
    const { grid } = renderPreview([tile()]);
    expect(grid.style.transform).toBe(`scale(${300 / REFERENCE_WIDTH})`);

    wrapperWidth = 450;
    act(() => resize?.());
    expect(grid.style.transform).toBe(`scale(${450 / REFERENCE_WIDTH})`);
  });

  it("is a picture: no pointer events, hidden from assistive tech, the footer names it", () => {
    const { grid } = renderPreview([tile()]);
    expect(grid.className).toContain("pointer-events-none");
    expect(grid.getAttribute("aria-hidden")).toBe("true");
  });

  it("issues no query while the preview has never been visible", () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: ["value"], rows: [[7]], meta: {} });
    renderPreview([tile(), tile({ id: "w2", x: 6 })]);
    expect(api.runWidgetQuery).not.toHaveBeenCalled();
    expect(screen.queryByText("Loading…")).toBeNull();
    // One observer for the whole preview, not one per tile.
    expect(observed).toHaveLength(1);
  });

  it("queries each chart tile once on visibility and draws the dashboard's own body", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: ["value"], rows: [[7]], meta: {} });
    renderPreview([tile(), tile({ id: "w2", x: 6 })]);
    scrollIntoView();

    await waitFor(() => expect(screen.getAllByText("7")).toHaveLength(2));
    expect(api.runWidgetQuery).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.runWidgetQuery).mock.calls[0][1]).toEqual(SPEC);
  });

  it("renders a feed tile with the real feed, aimed at the same frozen window", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: ["value"], rows: [[7]], meta: {} });
    renderPreview([tile(), FEED]);
    scrollIntoView();

    const feed = await screen.findByTestId("trace-feed");
    await waitFor(() => expect(api.runWidgetQuery).toHaveBeenCalledTimes(1));
    // The chart's query hook floors the shared window to the minute before
    // it reaches the API; the feed takes the window as frozen.
    const [, start, end] = feed.textContent!.match(/^p1:(\d+)-(\d+)$/)!;
    const floored = quantizeRange({ start: new Date(Number(start)), end: new Date(Number(end)) });
    expect(vi.mocked(api.runWidgetQuery).mock.calls[0][2]).toEqual(floored);
    expect(Number(end) - Number(start)).toBe(24 * 60 * 60 * 1000);
  });

  it("shows the dashboard's own invalid-spec face for a spec the schema rejects, querying nothing", async () => {
    renderPreview([tile({ widget: { type: "query", spec: { view: "spans" } } })]);
    scrollIntoView();

    expect(await screen.findByText("Invalid widget spec — edit to fix")).toBeTruthy();
    expect(api.runWidgetQuery).not.toHaveBeenCalled();
  });

  it("freezes one shared window across every tile, the default 24 hours", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: ["value"], rows: [[7]], meta: {} });
    const { client, rerenderPreview } = renderPreview([tile(), tile({ id: "w2", x: 6 })]);
    scrollIntoView();

    await waitFor(() => expect(api.runWidgetQuery).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(api.runWidgetQuery).mock.calls.map((c) => c[2]);
    expect(first.start.getTime()).toBe(second.start.getTime());
    expect(first.end.getTime()).toBe(second.end.getTime());
    expect(first.end.getTime() - first.start.getTime()).toBe(24 * 60 * 60 * 1000);

    // The freeze holds beyond the first render: minutes later, a re-render
    // plus a forced refetch still queries the window frozen at first
    // visibility — never one recomputed at the new "now".
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 5 * 60_000);
      rerenderPreview();
      await act(() => client.invalidateQueries());
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() =>
      expect(vi.mocked(api.runWidgetQuery).mock.calls.length).toBeGreaterThanOrEqual(4),
    );
    for (const call of vi.mocked(api.runWidgetQuery).mock.calls) {
      expect(call[2].start.getTime()).toBe(first.start.getTime());
      expect(call[2].end.getTime()).toBe(first.end.getTime());
    }
  });

  it("freezes the range the card snapshotted, not one it resolves itself", async () => {
    // The card's header names the tiles' window; the preview must draw that
    // same snapshot even if the site's stored selection has since changed.
    window.localStorage.setItem("traceroot:date-filter:v1:p1", JSON.stringify({ id: "30d" }));
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: ["value"], rows: [[7]], meta: {} });
    renderPreview([tile({ range: DATE_FILTER_OPTIONS.find((o) => o.id === "14d")! })]);
    scrollIntoView();

    await waitFor(() => expect(api.runWidgetQuery).toHaveBeenCalledTimes(1));
    const range = vi.mocked(api.runWidgetQuery).mock.calls[0][2];
    expect(range.end.getTime() - range.start.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it("refires no tile query on window focus — a card is a snapshot, not a dashboard", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: ["value"], rows: [[7]], meta: {} });
    renderPreview([tile(), tile({ id: "w2", x: 6 })]);
    scrollIntoView();
    await waitFor(() => expect(api.runWidgetQuery).toHaveBeenCalledTimes(2));

    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 10 * 60_000);
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      // The focus subscriber checks staleness asynchronously; the fake clock
      // stays advanced until it has had the chance to (wrongly) refetch.
      await act(() => new Promise((resolve) => setTimeout(resolve, 25)));
      expect(api.runWidgetQuery).toHaveBeenCalledTimes(2);
    } finally {
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });

  it("renders nothing for an empty tile list", () => {
    const { container } = render(<DashboardPreview tiles={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
