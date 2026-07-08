// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LayoutItem, TimeRange, Widget } from "../types";
import { DashboardGrid } from "./DashboardGrid";

// DashboardGrid only cares about the layout it hands to react-grid-layout and
// the onLayoutChange callback it wires up — stub the library component so the
// test can capture both without exercising the real drag/resize engine.
const gridLayoutMock = vi.fn(
  (props: {
    children?: React.ReactNode;
    layout: LayoutItem[];
    onLayoutChange: (l: LayoutItem[]) => void;
  }) => <div data-testid="grid-layout">{props.children}</div>,
);
vi.mock("react-grid-layout", () => ({
  GridLayout: (props: unknown) => gridLayoutMock(props as never),
}));

// WidgetCard pulls in its own data hooks; the layout logic under test doesn't
// need a real widget body.
vi.mock("./WidgetCard", () => ({
  WidgetCard: ({ widget }: { widget: Widget }) => <div>{widget.id}</div>,
}));

const RANGE: TimeRange = {
  start: new Date("2026-06-01T00:00:00Z"),
  end: new Date("2026-06-02T00:00:00Z"),
};

function widget(id: string): Widget {
  return {
    id,
    dashboardId: "d1",
    title: id,
    type: "trace_feed",
    spec: {},
    displayConfig: {},
  };
}

function latestProps() {
  const calls = gridLayoutMock.mock.calls;
  return calls[calls.length - 1][0] as {
    layout: LayoutItem[];
    onLayoutChange: (l: LayoutItem[]) => void;
  };
}

describe("DashboardGrid", () => {
  afterEach(() => {
    cleanup();
    gridLayoutMock.mockClear();
  });

  describe("fullLayout mapping", () => {
    it("keeps known layout entries as-is, appends missing widgets at the bottom, and ignores stale entries", () => {
      const widgets = [widget("w1"), widget("w2"), widget("w3")];
      const layout: LayoutItem[] = [
        { i: "w1", x: 2, y: 5, w: 6, h: 3 },
        // Stale entry for a widget that no longer exists — its y+h still
        // factors into the "append at the bottom" watermark.
        { i: "w-deleted", x: 0, y: 20, w: 4, h: 4 },
      ];

      render(
        <DashboardGrid
          projectId="p1"
          widgets={widgets}
          layout={layout}
          range={RANGE}
          width={1000}
          onLayoutChange={vi.fn()}
          onEdit={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
        />,
      );

      const fullLayout = latestProps().layout;
      expect(fullLayout).toEqual([
        { i: "w1", x: 2, y: 5, w: 6, h: 3, minW: 2, minH: 2 },
        { i: "w2", x: 0, y: 24, w: 4, h: 4, minW: 2, minH: 2 },
        { i: "w3", x: 0, y: 28, w: 4, h: 4, minW: 2, minH: 2 },
      ]);
      // The deleted widget's stale layout entry never surfaces.
      expect(fullLayout.some((l) => l.i === "w-deleted")).toBe(false);
    });

    it("starts fresh widgets at y:0 when there is no stored layout", () => {
      const widgets = [widget("w1")];
      render(
        <DashboardGrid
          projectId="p1"
          widgets={widgets}
          layout={[]}
          range={RANGE}
          width={1000}
          onLayoutChange={vi.fn()}
          onEdit={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
        />,
      );

      expect(latestProps().layout).toEqual([{ i: "w1", x: 0, y: 0, w: 4, h: 4, minW: 2, minH: 2 }]);
    });

    it("marks every item static and never persists layout changes when read-only", () => {
      vi.useFakeTimers();
      const onLayoutChange = vi.fn();
      render(
        <DashboardGrid
          projectId="p1"
          widgets={[widget("w1")]}
          layout={[{ i: "w1", x: 0, y: 0, w: 4, h: 4 }]}
          range={RANGE}
          width={1000}
          readOnly
          onLayoutChange={onLayoutChange}
          onEdit={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
        />,
      );

      const { layout: fullLayout, onLayoutChange: onChange } = latestProps();
      expect(fullLayout).toEqual([
        { i: "w1", x: 0, y: 0, w: 4, h: 4, minW: 2, minH: 2, static: true },
      ]);

      // Even if the grid fires (e.g. mount-fire compaction), nothing goes upstream.
      onChange([{ i: "w1", x: 2, y: 0, w: 4, h: 4 }]);
      vi.advanceTimersByTime(600);
      expect(onLayoutChange).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("stamps the minimum size on every item so widgets can't be shrunk into clipping", () => {
      const widgets = [widget("w1"), widget("w2")];
      render(
        <DashboardGrid
          projectId="p1"
          widgets={widgets}
          layout={[{ i: "w1", x: 0, y: 0, w: 6, h: 3 }]}
          range={RANGE}
          width={1000}
          onLayoutChange={vi.fn()}
          onEdit={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
        />,
      );

      for (const item of latestProps().layout) {
        expect(item).toMatchObject({ minW: 2, minH: 2 });
      }
    });
  });

  describe("handleChange debounce", () => {
    const widgets = [widget("w1"), widget("w2")];
    const initialLayout: LayoutItem[] = [
      { i: "w1", x: 0, y: 0, w: 4, h: 4 },
      { i: "w2", x: 4, y: 0, w: 4, h: 4 },
    ];

    function renderGrid(onLayoutChange: (l: LayoutItem[]) => void) {
      const utils = render(
        <DashboardGrid
          projectId="p1"
          widgets={widgets}
          layout={initialLayout}
          range={RANGE}
          width={1000}
          onLayoutChange={onLayoutChange}
          onEdit={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
      return { ...utils, onChange: latestProps().onLayoutChange };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("never calls upstream for the mount-fire, even after the debounce elapses", () => {
      vi.useFakeTimers();
      const onLayoutChange = vi.fn();
      const { onChange } = renderGrid(onLayoutChange);

      // react-grid-layout fires onLayoutChange on mount with the same layout
      // it was given.
      onChange(initialLayout);
      vi.advanceTimersByTime(600);

      expect(onLayoutChange).not.toHaveBeenCalled();
    });

    it("calls upstream once, 600ms after a genuine layout change", () => {
      vi.useFakeTimers();
      const onLayoutChange = vi.fn();
      const { onChange } = renderGrid(onLayoutChange);

      onChange(initialLayout); // mount-fire, lazily initializes the sent snapshot
      vi.advanceTimersByTime(600);
      expect(onLayoutChange).not.toHaveBeenCalled();

      const moved: LayoutItem[] = [
        { i: "w1", x: 2, y: 0, w: 4, h: 4 },
        { i: "w2", x: 4, y: 0, w: 4, h: 4 },
      ];
      onChange(moved);
      expect(onLayoutChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(600);

      expect(onLayoutChange).toHaveBeenCalledTimes(1);
      expect(onLayoutChange).toHaveBeenCalledWith(moved);
    });

    it("dedupes an identical repeat of a layout already sent", () => {
      vi.useFakeTimers();
      const onLayoutChange = vi.fn();
      const { onChange } = renderGrid(onLayoutChange);

      const moved: LayoutItem[] = [
        { i: "w1", x: 2, y: 0, w: 4, h: 4 },
        { i: "w2", x: 4, y: 0, w: 4, h: 4 },
      ];
      onChange(initialLayout);
      onChange(moved);
      vi.advanceTimersByTime(600);
      expect(onLayoutChange).toHaveBeenCalledTimes(1);

      // Same layout content again (new array identity, same values).
      onChange([...moved.map((l) => ({ ...l }))]);
      vi.advanceTimersByTime(600);

      expect(onLayoutChange).toHaveBeenCalledTimes(1);
    });

    it("collapses rapid successive changes into a single call for the latest layout", () => {
      vi.useFakeTimers();
      const onLayoutChange = vi.fn();
      const { onChange } = renderGrid(onLayoutChange);

      onChange(initialLayout); // mount-fire
      const v1: LayoutItem[] = [
        { i: "w1", x: 1, y: 0, w: 4, h: 4 },
        { i: "w2", x: 4, y: 0, w: 4, h: 4 },
      ];
      const v2: LayoutItem[] = [
        { i: "w1", x: 2, y: 0, w: 4, h: 4 },
        { i: "w2", x: 4, y: 0, w: 4, h: 4 },
      ];
      const v3: LayoutItem[] = [
        { i: "w1", x: 3, y: 0, w: 4, h: 4 },
        { i: "w2", x: 4, y: 0, w: 4, h: 4 },
      ];
      onChange(v1);
      onChange(v2);
      onChange(v3);

      vi.advanceTimersByTime(600);

      expect(onLayoutChange).toHaveBeenCalledTimes(1);
      expect(onLayoutChange).toHaveBeenCalledWith(v3);
    });

    it("flushes a pending debounced change synchronously on unmount", () => {
      vi.useFakeTimers();
      const onLayoutChange = vi.fn();
      const { onChange, unmount } = renderGrid(onLayoutChange);

      onChange(initialLayout); // mount-fire
      const moved: LayoutItem[] = [
        { i: "w1", x: 2, y: 0, w: 4, h: 4 },
        { i: "w2", x: 4, y: 0, w: 4, h: 4 },
      ];
      onChange(moved); // pending debounce, not yet flushed

      unmount();

      expect(onLayoutChange).toHaveBeenCalledTimes(1);
      expect(onLayoutChange).toHaveBeenCalledWith(moved);
    });
  });
});
