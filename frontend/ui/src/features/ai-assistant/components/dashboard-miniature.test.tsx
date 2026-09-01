// @vitest-environment jsdom
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import * as api from "@/features/dashboards/api";
import { COLS, ROW_HEIGHT } from "@/features/dashboards/grid-constants";
import { DISPLAY_TYPES, type WidgetSpec } from "@/features/dashboards/types";
import {
  DashboardMiniature,
  REFERENCE_COL_WIDTH,
  frameStyle,
  tileStyle,
} from "./dashboard-miniature";
import type { MiniatureTile } from "../lib/resource-card";

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1", email: "u@example.com" } }, isPending: false }),
}));
vi.mock("@/features/dashboards/api");

// jsdom has no IntersectionObserver; this one records every observed element
// so a test can decide when the miniature scrolls into view.
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function spec(display: WidgetSpec["display"]["type"], measure = "total_tokens"): WidgetSpec {
  return {
    view: "spans",
    filters: [],
    metric: { measure, agg: "sum" },
    breakdown: null,
    display: { type: display },
  };
}

function tile(overrides: Partial<MiniatureTile> = {}): MiniatureTile {
  return {
    id: "w1",
    title: "p95 latency",
    glyph: "line",
    chart: null,
    x: 0,
    y: 0,
    w: 6,
    h: 4,
    ...overrides,
  };
}

/** A tile whose widget carries a runnable query spec. */
function liveTile(overrides: Partial<MiniatureTile> = {}, display = "line"): MiniatureTile {
  const glyph = display as MiniatureTile["glyph"];
  return tile({
    glyph,
    chart: { projectId: "p1", spec: spec(display as WidgetSpec["display"]["type"]) },
    ...overrides,
  });
}

// A four-widget mixed dashboard, laid out the way the placement function does.
const MIXED: MiniatureTile[] = [
  tile(),
  tile({ id: "w2", title: "Errors", glyph: "bar", x: 6 }),
  tile({ id: "w3", title: "Recent traces", glyph: "trace_feed", y: 6, h: 6 }),
  tile({ id: "w4", title: "Cost", glyph: "number", x: 6, y: 6 }),
];

describe("frameStyle", () => {
  it("derives the frame from the grid's real column count and row height", () => {
    const style = frameStyle(MIXED);
    // 12 rows deep: the 6x6 feed bottoms out at y=12.
    expect(style.gridTemplateColumns).toBe(`repeat(${COLS}, minmax(0, 1fr))`);
    expect(style.gridTemplateRows).toBe(`repeat(12, minmax(0, 1fr))`);
    expect(style.aspectRatio).toBe(`${COLS * REFERENCE_COL_WIDTH} / ${12 * ROW_HEIGHT}`);
  });

  it("keeps a 6x4 chart tile at the real grid's ~2.35:1, not squashed", () => {
    // Tile width over height at the reference scale — the proportions the
    // dashboard itself renders. A regression to ~4.8:1 fails here.
    const aspect = (6 * REFERENCE_COL_WIDTH) / (4 * ROW_HEIGHT);
    expect(aspect).toBeGreaterThan(2.2);
    expect(aspect).toBeLessThan(2.5);
  });
});

describe("tileStyle", () => {
  it("maps grid-unit placement onto css grid lines", () => {
    expect(tileStyle(tile({ x: 6, y: 6, w: 6, h: 6 }))).toEqual({
      gridColumn: "7 / span 6",
      gridRow: "7 / span 6",
    });
  });
});

describe("DashboardMiniature", () => {
  it("renders one named tile per widget", () => {
    const { container } = render(<DashboardMiniature tiles={MIXED} />);
    expect(container.querySelectorAll("[data-glyph]").length).toBe(4);
    expect(screen.getByText("p95 latency")).toBeTruthy();
    expect(screen.getByText("Recent traces")).toBeTruthy();
  });

  it("draws a static glyph for each display type and rows for a feed", () => {
    const { container } = render(<DashboardMiniature tiles={MIXED} />);
    expect(container.querySelector('[data-glyph="line"] svg')).toBeTruthy();
    expect(container.querySelector('[data-glyph="bar"] svg')).toBeTruthy();
    expect(container.querySelector('[data-glyph="number"] svg')).toBeTruthy();
    // A feed is list rows, not a chart shape.
    expect(container.querySelector('[data-glyph="trace_feed"] svg')).toBeNull();
    expect(
      container.querySelectorAll('[data-glyph="trace_feed"] [data-feed-row]').length,
    ).toBeGreaterThan(2);
  });

  it("has a shape for every display type the widget schema knows", () => {
    const tiles = DISPLAY_TYPES.map((display, index) =>
      tile({ id: `w-${display}`, title: display, glyph: display, y: index * 4 }),
    );
    const { container } = render(<DashboardMiniature tiles={tiles} />);
    for (const display of DISPLAY_TYPES) {
      expect(container.querySelector(`[data-glyph="${display}"] svg`)).toBeTruthy();
    }
  });

  it("leaves an unknown display as a neutral tile with only its title", () => {
    const { container } = render(
      <DashboardMiniature tiles={[tile({ glyph: "unknown", title: "Mystery" })]} />,
    );
    expect(screen.getByText("Mystery")).toBeTruthy();
    expect(container.querySelector('[data-glyph="unknown"] svg')).toBeNull();
  });

  it("truncates a tile title rather than letting it widen the miniature", () => {
    render(<DashboardMiniature tiles={[tile({ title: "A very long widget title indeed" })]} />);
    const title = screen.getByText("A very long widget title indeed");
    expect(title.className).toContain("truncate");
  });

  it("issues no fetch when nothing marks the miniature visible", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<DashboardMiniature tiles={MIXED} />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("offers no buttons — the miniature is a receipt, not a control", () => {
    const { container } = render(<DashboardMiniature tiles={MIXED} />);
    expect(container.querySelectorAll("button").length).toBe(0);
  });

  it("renders nothing for an empty tile list", () => {
    const { container } = render(<DashboardMiniature tiles={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("DashboardMiniature live tiles", () => {
  beforeEach(() => {
    observed = [];
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    vi.mocked(api.runWidgetQuery).mockReset();
  });

  function renderLive(tiles: MiniatureTile[]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // A fresh element per (re)render — reusing one element lets React bail
    // out on identity and skip the re-render a test means to force.
    const ui = () => (
      <QueryClientProvider client={client}>
        <DashboardMiniature tiles={tiles} />
      </QueryClientProvider>
    );
    const result = render(ui());
    return { client, ...result, rerenderLive: () => result.rerender(ui()) };
  }

  it("issues no query while the miniature has never been visible", () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: ["value"], rows: [[7]], meta: {} });
    const { container } = renderLive([liveTile(), liveTile({ id: "w2", x: 6 }, "number")]);
    expect(api.runWidgetQuery).not.toHaveBeenCalled();
    // The static glyphs stand in until then.
    expect(container.querySelector('[data-glyph="line"] svg')).toBeTruthy();
    // One observer for the whole miniature, not one per tile.
    expect(observed).toHaveLength(1);
  });

  it("queries each chart tile once on visibility; a feed tile never queries", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: ["value"], rows: [[7]], meta: {} });
    renderLive([
      liveTile({ id: "w1" }, "number"),
      liveTile({ id: "w2", x: 6 }, "number"),
      tile({ id: "w3", title: "Recent", glyph: "trace_feed", y: 6, h: 6 }),
    ]);
    scrollIntoView();

    await waitFor(() => expect(api.runWidgetQuery).toHaveBeenCalledTimes(2));
    const queried = vi.mocked(api.runWidgetQuery).mock.calls.map((c) => c[1]);
    expect(queried).toEqual([spec("number"), spec("number")]);
  });

  it("freezes one shared window across every tile, the default 24 hours", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: ["value"], rows: [[7]], meta: {} });
    const { client, rerenderLive } = renderLive([
      liveTile({ id: "w1" }, "number"),
      liveTile({ id: "w2", x: 6 }, "line"),
    ]);
    scrollIntoView();

    await waitFor(() => expect(api.runWidgetQuery).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(api.runWidgetQuery).mock.calls.map((c) => c[2]);
    expect(first.start.getTime()).toBe(second.start.getTime());
    expect(first.end.getTime()).toBe(second.end.getTime());
    expect(first.end.getTime() - first.start.getTime()).toBe(24 * 60 * 60 * 1000);

    // The freeze must hold beyond the first render: minutes later, a
    // re-render plus a forced refetch still queries the window frozen at
    // first visibility — never one recomputed at the new "now".
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 5 * 60_000);
      rerenderLive();
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

  it("refires no tile query on window focus — a card is a snapshot, not a dashboard", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: ["value"], rows: [[7]], meta: {} });
    renderLive([liveTile({ id: "w1" }, "number"), liveTile({ id: "w2", x: 6 }, "line")]);
    scrollIntoView();
    await waitFor(() => expect(api.runWidgetQuery).toHaveBeenCalledTimes(2));

    // Minutes pass, then the user tabs away and back. Every ever-visible card
    // in the transcript holds a live query, so a focus refetch here would
    // refire the whole accumulated transcript against ClickHouse.
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

  it("renders a number tile's fetched value small, in tabular figures", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({
      columns: ["value"],
      rows: [[1234]],
      meta: {},
    });
    renderLive([liveTile({}, "number")]);
    scrollIntoView();

    const value = await screen.findByText("1,234");
    expect(value.className).toContain("tabular-nums");
  });

  it("prefixes a measure's unit onto the fetched number", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({
      columns: ["value"],
      rows: [[12.5]],
      meta: {},
    });
    renderLive([
      tile({ glyph: "number", chart: { projectId: "p1", spec: spec("number", "cost") } }),
    ]);
    scrollIntoView();

    const value = await screen.findByText(/\$/);
    expect(value.textContent).toContain("12.5");
  });

  it("draws a line tile's polyline from the fetched buckets", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({
      columns: ["bucket", "value"],
      rows: [
        ["2026-06-01T00:00:00", 0],
        ["2026-06-01T01:00:00", 10],
        ["2026-06-01T02:00:00", 5],
      ],
      meta: { granularity: "hour" },
    });
    const { container } = renderLive([liveTile()]);
    scrollIntoView();

    await waitFor(() => expect(container.querySelector("[data-live-mini]")).toBeTruthy());
    const polyline = container.querySelector("[data-live-mini] polyline");
    expect(polyline?.getAttribute("points")).toBe("0,40 48,2 96,21");
  });

  it("draws one polyline per breakdown series", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({
      columns: ["bucket", "model_name", "value"],
      rows: [
        ["2026-06-01T00:00:00", "haiku", 1],
        ["2026-06-01T00:00:00", "sonnet", 2],
        ["2026-06-01T01:00:00", "haiku", 3],
        ["2026-06-01T01:00:00", "sonnet", 4],
      ],
      meta: { granularity: "hour" },
    });
    const { container } = renderLive([liveTile()]);
    scrollIntoView();

    await waitFor(() =>
      expect(container.querySelectorAll("[data-live-mini] polyline").length).toBe(2),
    );
  });

  it("fills an area tile under its fetched series", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({
      columns: ["bucket", "value"],
      rows: [
        ["2026-06-01T00:00:00", 2],
        ["2026-06-01T01:00:00", 6],
      ],
      meta: { granularity: "hour" },
    });
    const { container } = renderLive([liveTile({}, "area")]);
    scrollIntoView();

    await waitFor(() => expect(container.querySelector("[data-live-mini] polygon")).toBeTruthy());
  });

  it("draws a bar tile's bars scaled to the fetched categories", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({
      columns: ["model_name", "value"],
      rows: [
        ["haiku", 4],
        ["sonnet", 8],
      ],
      meta: {},
    });
    const { container } = renderLive([liveTile({}, "bar")]);
    scrollIntoView();

    await waitFor(() => expect(container.querySelectorAll("[data-live-mini] rect").length).toBe(2));
    const heights = [...container.querySelectorAll("[data-live-mini] rect")].map((r) =>
      Number(r.getAttribute("height")),
    );
    expect(heights).toEqual([19, 38]);
  });

  it("draws a histogram tile's bins from the fetched rows", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({
      columns: ["lo", "hi", "count"],
      rows: [
        [0, 10, 3],
        [10, 20, 6],
      ],
      meta: {},
    });
    const { container } = renderLive([liveTile({}, "histogram")]);
    scrollIntoView();

    await waitFor(() => expect(container.querySelectorAll("[data-live-mini] rect").length).toBe(2));
  });

  it("draws a pie tile's sectors in the fetched proportions", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({
      columns: ["model_name", "value"],
      rows: [
        ["haiku", 3],
        ["sonnet", 1],
      ],
      meta: {},
    });
    const { container } = renderLive([liveTile({}, "pie")]);
    scrollIntoView();

    await waitFor(() => expect(container.querySelectorAll("[data-live-mini] path").length).toBe(2));
    // The actual arc geometry, not just "two slices exist": 3:1 splits the
    // r=14 circle at twelve o'clock into a 270° major arc ending at nine
    // o'clock (large-arc flag set) and a 90° minor arc back to the top.
    const [major, minor] = [...container.querySelectorAll("[data-live-mini] path")].map((p) =>
      p.getAttribute("d"),
    );
    expect(major).toBe("M20,20 L20,6 A14,14 0 1 1 6,20 Z");
    expect(minor).toBe("M20,20 L6,20 A14,14 0 0 1 20,6 Z");
  });

  it("lists a table tile's first fetched rows", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({
      columns: ["model_name", "value"],
      rows: [
        ["haiku", 41],
        ["sonnet", 7],
      ],
      meta: {},
    });
    renderLive([liveTile({}, "table")]);
    scrollIntoView();

    expect(await screen.findByText("haiku")).toBeTruthy();
    expect(screen.getByText("41")).toBeTruthy();
  });

  it("keeps the static glyph when a tile's query fails — never an error text", async () => {
    vi.mocked(api.runWidgetQuery).mockRejectedValue(new Error("clickhouse exploded"));
    const { container } = renderLive([liveTile()]);
    scrollIntoView();

    await waitFor(() => expect(api.runWidgetQuery).toHaveBeenCalled());
    // The glyph outlasts the failure, and nothing prints inside the tile.
    await waitFor(() => expect(container.querySelector('[data-glyph="line"] svg')).toBeTruthy());
    expect(container.querySelector("[data-live-mini]")).toBeNull();
    expect(screen.queryByText(/couldn't|error|exploded/i)).toBeNull();
  });

  it("renders the subtle empty treatment for a window with no rows", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: ["value"], rows: [], meta: {} });
    const { container } = renderLive([liveTile({}, "number")]);
    scrollIntoView();

    await waitFor(() => expect(container.querySelector("[data-mini-empty]")).toBeTruthy());
    expect(container.querySelector("[data-mini-empty]")?.textContent).toBe("—");
  });

  it("shows the glyph while the query is in flight", async () => {
    vi.mocked(api.runWidgetQuery).mockReturnValue(new Promise(() => {}));
    const { container } = renderLive([liveTile()]);
    scrollIntoView();

    await waitFor(() => expect(api.runWidgetQuery).toHaveBeenCalled());
    expect(container.querySelector('[data-glyph="line"] svg polyline')).toBeTruthy();
    expect(container.querySelector("[data-live-mini]")).toBeNull();
  });

  it("reads decimal strings and compacts large values like the stat tile", async () => {
    // ClickHouse returns Decimal columns as strings.
    vi.mocked(api.runWidgetQuery).mockResolvedValue({
      columns: ["value"],
      rows: [["250000.5"]],
      meta: {},
    });
    renderLive([liveTile({}, "number")]);
    scrollIntoView();

    expect(await screen.findByText("250K")).toBeTruthy();
  });

  it("suffixes a duration number with its unit", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({
      columns: ["value"],
      rows: [[1500]],
      meta: {},
    });
    renderLive([
      tile({ glyph: "number", chart: { projectId: "p1", spec: spec("number", "duration_ms") } }),
    ]);
    scrollIntoView();

    const value = await screen.findByText(/1,500/);
    expect(value.textContent).toBe("1,500 ms");
  });

  it("draws a whole circle for a pie with a single category", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({
      columns: ["model_name", "value"],
      rows: [["haiku", 3]],
      meta: {},
    });
    const { container } = renderLive([liveTile({}, "pie")]);
    scrollIntoView();

    await waitFor(() => expect(container.querySelector("[data-live-mini] circle")).toBeTruthy());
    expect(container.querySelectorAll("[data-live-mini] path").length).toBe(0);
  });

  it("draws a lone bucket's value flat across the tile", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({
      columns: ["bucket", "value"],
      rows: [["2026-06-01T00:00:00", 5]],
      meta: { granularity: "hour" },
    });
    const { container } = renderLive([liveTile()]);
    scrollIntoView();

    await waitFor(() => expect(container.querySelector("[data-live-mini] polyline")).toBeTruthy());
    const polyline = container.querySelector("[data-live-mini] polyline");
    expect(polyline?.getAttribute("points")).toBe("0,2 96,2");
  });
});
