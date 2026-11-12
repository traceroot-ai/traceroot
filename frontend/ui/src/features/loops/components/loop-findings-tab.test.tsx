// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { LoopFindingDto } from "@traceroot/core/loops/pure";
import { LoopFindingsTab } from "./loop-findings-tab";

afterEach(cleanup);

const finding = (over: Partial<LoopFindingDto> = {}): LoopFindingDto => ({
  signalId: "sig 1",
  title: "Agents re-read the same large file",
  status: "open",
  groupKey: "loop:repeated-reads",
  criteriaCovers: "Sessions that read one file three times.",
  hitCount: 6,
  firstSeenAt: "2026-11-09T00:00:00Z",
  lastSeenAt: "2026-11-11T00:00:00Z",
  ...over,
});

describe("LoopFindingsTab", () => {
  it("lists each finding with its status, hits and a link that opens it on the Signals page", () => {
    render(
      <LoopFindingsTab
        projectId="p1"
        dryRun={false}
        findings={[
          finding(),
          finding({ signalId: "sig2", title: "Edits reverted", status: "resolved", hitCount: 3 }),
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: "Agents re-read the same large file" });
    expect(link.getAttribute("href")).toBe("/projects/p1/signals?signalId=sig%201");
    expect(screen.getByText("open")).toBeTruthy();
    expect(screen.getByText("resolved")).toBeTruthy();
    expect(screen.getAllByText("Sessions that read one file three times.")).toHaveLength(2);
    expect(screen.getByText("6")).toBeTruthy();
  });

  it("says what an empty tab means, and why for a dry-run Loop", () => {
    const { rerender } = render(<LoopFindingsTab projectId="p1" dryRun={false} findings={[]} />);
    expect(screen.getByText("No findings yet")).toBeTruthy();
    expect(screen.getByText(/appears here, and under Signals/)).toBeTruthy();
    rerender(<LoopFindingsTab projectId="p1" dryRun={true} findings={[]} />);
    expect(screen.getByText(/dry-run Loop/)).toBeTruthy();
  });
});
