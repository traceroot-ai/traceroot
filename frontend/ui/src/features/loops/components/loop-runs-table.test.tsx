// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import type { LoopRunDto, LoopRunStatus } from "@traceroot/core/loops/pure";
import { LoopRunsTable } from "./loop-runs-table";

afterEach(cleanup);

let n = 0;
const run = (status: LoopRunStatus, over: Partial<LoopRunDto> = {}): LoopRunDto => {
  n += 1;
  return {
    id: `r${n}`,
    loopId: "l1",
    seq: 100 - n,
    trigger: "schedule",
    slotAt: null,
    status,
    attempts: 1,
    sessionId: null,
    startedAt: "2026-11-11T09:00:00Z",
    finishedAt: "2026-11-11T09:05:00Z",
    summary: null,
    findingKeys: [],
    tracesRead: 0,
    error: null,
    metadata: null,
    costUsd: null,
    createTime: "2026-11-11T09:00:00Z",
    ...over,
  };
};

describe("LoopRunsTable", () => {
  it("reads every outcome the way the seed's states need", () => {
    const rows = [
      run("succeeded", {
        findingKeys: ["a", "b"],
        summary: "Two problems.",
        tracesRead: 19,
        costUsd: 0.412,
      }),
      run("failed", {
        error: 'BYOK provider "my-openai" not found or disabled in workspace settings',
      }),
      run("timed_out", {
        error: "The run did not finish within 20 minutes and was stopped.",
        finishedAt: "2026-11-11T09:20:00Z",
      }),
      run("skipped_blocked", { error: "Skipped: the workspace reached its loop run limit." }),
      run("running", { finishedAt: null }),
      run("pending", { trigger: "manual", startedAt: null, finishedAt: null }),
    ];
    render(<LoopRunsTable runs={rows} onOpenTranscript={() => {}} />);
    // One word per status, as the detector runs table shows it; the full outcome is its title.
    expect(screen.getByTitle("Succeeded · 2 findings").textContent).toBe("Succeeded");
    expect(screen.getByTitle("Two problems.")).toBeTruthy();
    expect(screen.getByText("$0.4120")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText(/BYOK provider "my-openai" not found or disabled/)).toBeTruthy();
    expect(screen.getByText("Timed out")).toBeTruthy();
    expect(screen.getByText("20m 0s")).toBeTruthy();
    expect(screen.getByTitle("Skipped (plan limit)").textContent).toBe("Skipped");
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Queued")).toBeTruthy();
    expect(screen.getByText(/· Manual/)).toBeTruthy();
    expect(screen.getAllByText(/· Schedule/)).toHaveLength(5);
    // One line per row: no pills, no stacked detail.
    for (const row of screen.getAllByRole("row").slice(1)) {
      expect(row.querySelectorAll("p")).toHaveLength(0);
    }
  });

  it("shows a failed or timed-out outcome in the destructive colour and the rest muted", () => {
    render(
      <LoopRunsTable
        runs={[
          run("failed", { error: "boom" }),
          run("timed_out"),
          run("succeeded", { summary: "fine", findingKeys: ["a"] }),
        ]}
        onOpenTranscript={() => {}}
      />,
    );
    expect(screen.getByText("Failed").className).toContain("text-destructive");
    expect(screen.getByText("Timed out").className).toContain("text-destructive");
    expect(screen.getByTitle("Succeeded · 1 finding").className).toContain("text-muted-foreground");
    expect(screen.getByTitle("boom")).toBeTruthy();
    expect(screen.getByTitle("fine")).toBeTruthy();
  });

  it("truncates a long summary on one line, with the full text in its title", () => {
    const long = "x".repeat(150);
    render(<LoopRunsTable runs={[run("quiet", { summary: long })]} onOpenTranscript={() => {}} />);
    const cell = screen.getByTitle(long);
    expect(cell.className).toContain("truncate");
    expect(cell.textContent).toBe("x".repeat(100) + "…");
  });

  it("opens a transcript only for a run that has a session", () => {
    const onOpen = vi.fn();
    const withSession = run("succeeded", { sessionId: "s1", seq: 7 });
    render(<LoopRunsTable runs={[withSession, run("failed")]} onOpenTranscript={onOpen} />);
    // The session id is the click target, as in the detector runs table.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText("s1").getAttribute("title")).toContain("transcript of run #7");
    fireEvent.click(screen.getByRole("button", { name: "s1" }));
    expect(onOpen).toHaveBeenCalledWith(withSession);
  });

  it("lists quiet and skipped runs as ordinary rows", () => {
    render(
      <LoopRunsTable
        runs={[run("succeeded"), run("quiet"), run("quiet"), run("skipped_blocked")]}
        onOpenTranscript={() => {}}
      />,
    );
    expect(screen.getAllByRole("row")).toHaveLength(5);
    expect(screen.getAllByText("Quiet")).toHaveLength(2);
  });

  it("marks the linked run", () => {
    const linked = run("quiet", { summary: "The linked one." });
    render(
      <LoopRunsTable
        runs={[run("succeeded", { summary: "Not linked." }), linked, run("quiet")]}
        onOpenTranscript={() => {}}
        highlightRunId={linked.id}
      />,
    );
    const row = screen.getByTitle("The linked one.").closest("tr")!;
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.className).toContain("bg-muted");
    expect(screen.getByTitle("Not linked.").closest("tr")!.getAttribute("aria-current")).toBeNull();
  });

  it("does not show a duration for a skipped run", () => {
    render(
      <LoopRunsTable
        runs={[run("skipped_blocked", { finishedAt: "2026-11-11T09:00:00Z" })]}
        onOpenTranscript={() => {}}
      />,
    );
    expect(screen.queryByText("0s")).toBeNull();
  });

  it("has the detector runs table's columns, with a one-word status", () => {
    render(<LoopRunsTable runs={[run("succeeded")]} onOpenTranscript={() => {}} />);
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual([
      "Timestamp",
      "Run",
      "Session ID",
      "Duration",
      "Cost",
      "Summary",
      "Status",
    ]);
    const cells = screen.getAllByRole("row")[1].querySelectorAll("td");
    expect(cells).toHaveLength(7);
    // Status is one word, as in the detector's table.
    expect(cells[6].textContent).not.toMatch(/·|\(/);
  });

  it("uses the detector table's em dash for every empty value", () => {
    render(
      <LoopRunsTable
        runs={[run("failed", { startedAt: null, finishedAt: null, costUsd: null })]}
        onOpenTranscript={() => {}}
      />,
    );
    const cells = screen.getAllByRole("row")[1].querySelectorAll("td");
    // Session ID, Duration, Cost, Summary.
    for (const i of [2, 3, 4, 5]) expect(cells[i].textContent).toBe("—");
    expect(screen.queryByText("-")).toBeNull();
  });

  it("shows no duration for a run that failed before its agent started", () => {
    render(
      <LoopRunsTable
        runs={[
          run("failed", { finishedAt: "2026-11-11T09:00:00Z" }),
          run("failed", { sessionId: null, finishedAt: "2026-11-11T09:00:03Z" }),
          run("failed", { sessionId: "s9", finishedAt: "2026-11-11T09:00:03Z" }),
        ]}
        onOpenTranscript={() => {}}
      />,
    );
    expect(screen.queryByText("0ms")).toBeNull();
    expect(screen.queryByText("3.0s")).not.toBeNull();
    const durations = screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.querySelectorAll("td")[3].textContent);
    expect(durations).toEqual(["—", "—", "3.0s"]);
  });
});
