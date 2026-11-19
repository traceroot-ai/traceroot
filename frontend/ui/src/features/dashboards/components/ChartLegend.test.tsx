// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChartLegend, type LegendEntry } from "./ChartLegend";

afterEach(cleanup);

const fmt = (v: number | null) => (v === null ? "—" : `#${v}`);

function makeEntries(n: number): LegendEntry[] {
  // ascending values so sorting is observable
  return Array.from({ length: n }, (_, i) => ({
    key: `s${i}`,
    label: `series-${i}`,
    color: `rgb(${i}, 0, 0)`,
    value: i * 10,
  }));
}

describe("ChartLegend", () => {
  it("sorts rows by value descending and keeps each entry's own color", () => {
    render(
      <ChartLegend
        entries={makeEntries(3)}
        total={30}
        format={fmt}
        hoveredKey={null}
        onHoverKey={vi.fn()}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "Total#30",
      "series-2#20",
      "series-1#10",
      "series-0#0",
    ]);
    // color follows the entry (its chart pivot index), not the sorted position
    const swatch = rows[1].querySelector("div[style]") as HTMLElement;
    expect(swatch.style.backgroundColor).toBe("rgb(2, 0, 0)");
  });

  it("shows a Total row only when a total is given", () => {
    const { unmount } = render(
      <ChartLegend
        entries={makeEntries(2)}
        total={99}
        format={fmt}
        hoveredKey={null}
        onHoverKey={vi.fn()}
      />,
    );
    expect(screen.getByText("Total")).toBeTruthy();
    expect(screen.getByText("#99")).toBeTruthy();
    unmount();

    render(
      <ChartLegend
        entries={makeEntries(2)}
        total={null}
        format={fmt}
        hoveredKey={null}
        onHoverKey={vi.fn()}
      />,
    );
    expect(screen.queryByText("Total")).toBeNull();
  });

  it("caps visible rows and expands the full list in a popover", () => {
    render(
      <ChartLegend
        entries={makeEntries(8)}
        total={null}
        format={fmt}
        hoveredKey={null}
        onHoverKey={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    const more = screen.getByRole("button", { name: "5 more" });

    fireEvent.click(more);
    const panel = screen.getByRole("dialog");
    expect(panel.textContent).toContain("series-0");
    expect(panel.textContent).toContain("series-7");
    // The tile rows stay in the DOM behind the popover but leave the
    // accessibility tree (aria-hidden), so only the popover's 8 rows count.
    expect(screen.getAllByRole("listitem")).toHaveLength(8);

    fireEvent.click(screen.getByRole("button", { name: "show less" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clears the hover whenever the popover closes (Escape or the toggle)", () => {
    // Outside-click and Escape dismissal are Radix Popover's own behavior; what
    // we own is that a close — however triggered — clears the hover, or a row
    // that unmounted mid-hover would leave the chart dimmed.
    const onHoverKey = vi.fn();
    render(
      <ChartLegend
        entries={makeEntries(5)}
        total={null}
        format={fmt}
        hoveredKey={null}
        onHoverKey={onHoverKey}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "2 more" }));
    const panel = screen.getByRole("dialog");
    fireEvent.mouseEnter(panel.querySelectorAll('[role="listitem"]')[4]!);
    expect(onHoverKey).toHaveBeenLastCalledWith("s0");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onHoverKey).toHaveBeenLastCalledWith(null);

    // reopen, hover, then collapse via the toggle — hover clears again
    fireEvent.click(screen.getByRole("button", { name: "2 more" }));
    fireEvent.mouseEnter(screen.getByRole("dialog").querySelectorAll('[role="listitem"]')[0]!);
    fireEvent.click(screen.getByRole("button", { name: "show less" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onHoverKey).toHaveBeenLastCalledWith(null);
  });

  it("reports hover enter/leave so the chart can dim other series", () => {
    const onHoverKey = vi.fn();
    render(
      <ChartLegend
        entries={makeEntries(2)}
        total={null}
        format={fmt}
        hoveredKey={null}
        onHoverKey={onHoverKey}
      />,
    );
    const [first] = screen.getAllByRole("listitem");
    fireEvent.mouseEnter(first);
    expect(onHoverKey).toHaveBeenLastCalledWith("s1"); // sorted first (value 10)
    fireEvent.mouseLeave(first);
    expect(onHoverKey).toHaveBeenLastCalledWith(null);
  });

  it("formats null values through the caller's formatter", () => {
    render(
      <ChartLegend
        entries={[{ key: "a", label: "a", color: "red", value: null }]}
        total={null}
        format={fmt}
        hoveredKey={null}
        onHoverKey={vi.fn()}
      />,
    );
    expect(screen.getByText("—")).toBeTruthy();
  });
});
