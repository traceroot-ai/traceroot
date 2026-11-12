// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import type { LoopRunDto, LoopRunStatus } from "@traceroot/core/loops/pure";
import { LoopRunsTable, groupRuns } from "./loop-runs-table";

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

describe("groupRuns", () => {
  it("folds two or more quiet or pre-check-skipped runs in a row, and leaves a single one alone", () => {
    const rows = groupRuns([
      run("succeeded"),
      run("quiet"),
      run("skipped_precheck"),
      run("quiet"),
      run("failed"),
      run("quiet"),
      run("timed_out"),
    ]);
    expect(rows.map((r) => (r.kind === "group" ? `group:${r.runs.length}` : r.run.status))).toEqual(
      ["succeeded", "group:3", "failed", "quiet", "timed_out"],
    );
  });

  it("never folds the runs a person has to read", () => {
    const rows = groupRuns([
      run("failed"),
      run("failed"),
      run("skipped_blocked"),
      run("skipped_blocked"),
    ]);
    expect(rows.every((r) => r.kind === "run")).toBe(true);
  });
});

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
      run("skipped_blocked", { error: "Skipped: the workspace reached its Loop run limit." }),
      run("running", { finishedAt: null }),
      run("pending", { trigger: "manual", startedAt: null, finishedAt: null }),
    ];
    render(<LoopRunsTable runs={rows} onOpenTranscript={() => {}} />);
    expect(screen.getByText("Succeeded · 2 findings")).toBeTruthy();
    expect(screen.getByText("Two problems.")).toBeTruthy();
    expect(screen.getByText("$0.4120")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText(/BYOK provider "my-openai" not found or disabled/)).toBeTruthy();
    expect(screen.getByText("Timed out")).toBeTruthy();
    expect(screen.getByText("20 min")).toBeTruthy();
    expect(screen.getByText("Skipped (plan limit)")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Queued")).toBeTruthy();
    expect(screen.getByText("Not started")).toBeTruthy();
    expect(screen.getByText("Manual")).toBeTruthy();
  });

  it("shows a failure in the danger colour and a summary in the muted one", () => {
    render(
      <LoopRunsTable
        runs={[
          run("failed", { error: "boom" }),
          run("succeeded", { summary: "fine", findingKeys: ["a"] }),
        ]}
        onOpenTranscript={() => {}}
      />,
    );
    expect(screen.getByText("boom").className).toContain("text-danger");
    expect(screen.getByText("fine").className).toContain("text-muted-foreground");
  });

  it("opens a transcript only for a run that has a session", () => {
    const onOpen = vi.fn();
    const withSession = run("succeeded", { sessionId: "s1", seq: 7 });
    render(<LoopRunsTable runs={[withSession, run("failed")]} onOpenTranscript={onOpen} />);
    expect(screen.getAllByRole("button", { name: /transcript/i })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Open the transcript of run 7" }));
    expect(onOpen).toHaveBeenCalledWith(withSession);
  });

  it("keeps quiet and skipped stretches folded until opened, then lists each run", () => {
    render(
      <LoopRunsTable
        runs={[
          run("succeeded"),
          run("quiet", { summary: "Nothing new." }),
          run("quiet"),
          run("skipped_precheck"),
        ]}
        onOpenTranscript={() => {}}
      />,
    );
    const toggle = screen.getByRole("button", {
      name: /2 quiet runs · 1 skipped \(no new traces\)/,
    });
    expect(screen.queryByText("Nothing new.")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("Nothing new.")).toBeTruthy();
    expect(
      within(toggle.closest("div")!.parentElement as HTMLElement).getAllByText("Quiet"),
    ).toHaveLength(2);
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
});
