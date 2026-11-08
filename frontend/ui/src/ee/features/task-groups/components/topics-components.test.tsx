// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { TopicsStatusPanel } from "./topics-status-panel";
import { TopicsTable, formatShare } from "./topics-table";
import { buildTrendSeries } from "./topics-trend-chart";
import { TopicBadge, topicTracesHref } from "./topic-badge";
import type { TaskGroupRow, TaskGroupsOverview } from "../types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

function overview(
  over: Partial<TaskGroupsOverview> & { status?: string } = {},
): TaskGroupsOverview {
  const { status = "active", ...rest } = over;
  return {
    state: {
      enabled: status !== "off",
      status: status as never,
      dailyCostCapUsd: 1,
      spentTodayUsd: 0.4,
      summariesToday: 10,
      keyConfigured: status !== "no_key",
    },
    minDigests: 100,
    digestsInWindow: 40,
    sampled: 0,
    ungrouped: 0,
    fittedAt: null,
    groups: [],
    days: [],
    refreshAvailableAt: null,
    ...rest,
  };
}

describe("TopicsStatusPanel", () => {
  const panel = (o: TaskGroupsOverview, canChange = true, onTurnOn = vi.fn()) =>
    render(
      <TopicsStatusPanel
        overview={o}
        canChange={canChange}
        turningOn={false}
        onTurnOn={onTurnOn}
      />,
    );

  it("explains the feature when off and offers to turn it on", () => {
    const onTurnOn = vi.fn();
    panel(overview({ status: "off" }), true, onTurnOn);
    expect(screen.getByText("Topics are off for this project")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(onTurnOn).toHaveBeenCalled();
  });

  it("offers nothing to a viewer who cannot change it", () => {
    panel(overview({ status: "off" }), false);
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
  });

  it("says plainly that a model key is missing", () => {
    panel(overview({ status: "no_key" }));
    expect(screen.getByText("An OpenAI API key is needed for Topics")).toBeTruthy();
  });

  it("says how far it is from enough data", () => {
    panel(overview({ status: "collecting", digestsInWindow: 40 }));
    expect(screen.getByText("Not enough data yet")).toBeTruthy();
    expect(screen.getByText(/40 of 100 traces summarized so far/)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
  });

  it("reports the spend cap, and keeps showing data once groups exist", () => {
    const capped = overview({ status: "capped", fittedAt: "2026-11-08T00:00:00Z" });
    capped.state.spentTodayUsd = 1;
    panel(capped);
    expect(screen.getByText("Today's spend cap has been reached")).toBeTruthy();
    expect(screen.queryByText("Not enough data yet")).toBeNull();
  });

  it("is silent when all is well", () => {
    const { container } = panel(overview({ fittedAt: "2026-11-08T00:00:00Z" }));
    expect(container.textContent).toBe("");
  });
});

const rows: TaskGroupRow[] = [
  {
    groupId: "g1",
    name: "Flight Booking",
    description: "Booking flights",
    count: 6,
    share: 0.6,
    trend: [{ day: "2026-11-07", count: 6 }],
  },
  { groupId: "g2", name: "Refunds", description: "", count: 0, share: 0, trend: [] },
];

describe("TopicsTable", () => {
  it("labels the share as an estimate and links each row to its traces", () => {
    render(
      <TopicsTable
        rows={rows}
        days={["2026-11-06", "2026-11-07"]}
        sampled={10}
        ungrouped={4}
        hrefFor={(id) => `/traces?g=${id}`}
      />,
    );
    expect(screen.getByText("Share (estimate)")).toBeTruthy();
    expect(screen.getByText("≈ 60%")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Flight Booking" }).getAttribute("href")).toBe(
      "/traces?g=g1",
    );
    expect(screen.getByText("No topic")).toBeTruthy();
    expect(screen.getByText("≈ 40%")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Flight Booking: traces per day, 0, 6/ })).toBeTruthy();
  });

  it("formats small shares without claiming precision", () => {
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(0.004)).toBe("<1%");
    expect(formatShare(0.126)).toBe("13%");
  });
});

describe("buildTrendSeries", () => {
  it("fills missing days with zero and sums the groups beyond the colour budget", () => {
    const many: TaskGroupRow[] = Array.from({ length: 14 }, (_, i) => ({
      groupId: `g${i}`,
      name: `G${i}`,
      description: "",
      count: 14 - i,
      share: 0.1,
      trend: [{ day: "2026-11-07", count: 14 - i }],
    }));
    const { keys, data } = buildTrendSeries(many, ["2026-11-06", "2026-11-07"]);
    expect(keys).toHaveLength(13);
    expect(keys.at(-1)).toBe("Other");
    expect(data[0]).toMatchObject({ day: "2026-11-06", G0: 0, Other: 0 });
    // The two smallest groups (counts 2 and 1) are summed into Other.
    expect(data[1].Other).toBe(3);
  });
});

describe("table colours", () => {
  it("gives each row the colour of its series in the chart", () => {
    const { container } = render(
      <TopicsTable
        rows={rows}
        days={["2026-11-07"]}
        sampled={10}
        ungrouped={0}
        hrefFor={() => "#"}
      />,
    );
    const swatches = container.querySelectorAll("tbody td:first-child a span[aria-hidden]");
    expect(swatches).toHaveLength(2);
    expect((swatches[0] as HTMLElement).style.background).not.toBe(
      (swatches[1] as HTMLElement).style.background,
    );
  });
});

describe("TopicBadge", () => {
  it("links to the group's traces as an exact filter and does not open the row", () => {
    const onRow = vi.fn();
    render(
      <div onClick={onRow}>
        <TopicBadge name="Refunds" groupId="g9" projectId="p1" />
      </div>,
    );
    const link = screen.getByRole("link", { name: "Topic: Refunds" });
    expect(link.getAttribute("href")).toBe(topicTracesHref("p1", "g9"));
    expect(decodeURIComponent(link.getAttribute("href")!)).toContain('"field":"group_id"');
    fireEvent.click(link);
    expect(onRow).not.toHaveBeenCalled();
  });

  it("is a plain chip without a project", () => {
    render(<TopicBadge name="Refunds" groupId="g9" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Refunds")).toBeTruthy();
  });
});
