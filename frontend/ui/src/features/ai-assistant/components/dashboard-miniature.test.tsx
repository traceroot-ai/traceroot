// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { COLS, ROW_HEIGHT } from "@/features/dashboards/grid-constants";
import { DISPLAY_TYPES } from "@/features/dashboards/types";
import {
  DashboardMiniature,
  REFERENCE_COL_WIDTH,
  frameStyle,
  tileStyle,
} from "./dashboard-miniature";
import type { MiniatureTile } from "../lib/resource-card";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function tile(overrides: Partial<MiniatureTile> = {}): MiniatureTile {
  return { id: "w1", title: "p95 latency", glyph: "line", x: 0, y: 0, w: 6, h: 4, ...overrides };
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

  it("issues no fetch: the tiles are shapes, never live queries", () => {
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
