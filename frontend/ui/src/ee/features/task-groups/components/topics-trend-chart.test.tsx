// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TopicsTrendChart } from "./topics-trend-chart";
import type { TaskGroupRow } from "../types";

afterEach(cleanup);

const row = (name: string, count: number): TaskGroupRow => ({
  groupId: name,
  name,
  description: "",
  count,
  share: 0.1,
  trend: [{ day: "2026-11-07", count }],
});

describe("TopicsTrendChart", () => {
  it("draws nothing without groups or days", () => {
    const { container } = render(<TopicsTrendChart rows={[]} days={["2026-11-07"]} />);
    expect(container.textContent).toBe("");
    const { container: second } = render(<TopicsTrendChart rows={[row("A", 1)]} days={[]} />);
    expect(second.textContent).toBe("");
  });

  it("titles the chart and lists every series in the legend, summing the rest as Other", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`Topic ${i}`, 10 - i));
    render(<TopicsTrendChart rows={rows} days={["2026-11-06", "2026-11-07"]} />);
    expect(screen.getByText("Over time")).toBeTruthy();
    expect(screen.getByTestId("topics-trend-chart")).toBeTruthy();
    const legend = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(legend).toContain("Topic 0");
    expect(legend).toContain("Other");
    expect(legend).not.toContain("Topic 9");
  });
});
