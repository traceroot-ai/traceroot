// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { LoopMemoryDto } from "@traceroot/core/loops/pure";
import { LoopMemoryList } from "./loop-memory-list";

beforeEach(() => vi.useFakeTimers({ now: new Date("2026-11-11T12:00:00Z"), toFake: ["Date"] }));
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const note = (over: Partial<LoopMemoryDto> = {}): LoopMemoryDto => ({
  id: "m1",
  loopId: null,
  loopName: null,
  key: "repo-conventions",
  content: "Services live under frontend/.",
  expiresAt: null,
  expired: false,
  updatedByRunId: null,
  updateTime: "2026-11-11T11:00:00Z",
  ...over,
});

describe("LoopMemoryList", () => {
  it("names the loop that last wrote each note, or says it was deleted", () => {
    render(
      <LoopMemoryList
        notes={[
          note(),
          note({ id: "m2", key: "mine", loopId: "l1", loopName: "Coding agents" }),
          note({ id: "m3", key: "theirs", loopId: "l2", loopName: "Cost drivers" }),
        ]}
      />,
    );
    expect(screen.getByText("Written by a deleted loop")).toBeTruthy();
    expect(screen.getByText("Written by Coding agents")).toBeTruthy();
    expect(screen.getByText("Written by Cost drivers")).toBeTruthy();
    expect(screen.queryByText(/shared by/i)).toBeNull();
    expect(screen.getAllByText("Services live under frontend/.")).toHaveLength(3);
  });

  it("says when a note expires, or that it does not", () => {
    render(
      <LoopMemoryList
        notes={[
          note({ id: "a", key: "a", expiresAt: "2026-11-14T12:00:00Z" }),
          note({ id: "b", key: "b", expiresAt: "2026-11-12T06:00:00Z" }),
          note({ id: "d", key: "d" }),
        ]}
      />,
    );
    expect(screen.getByText("Expires in 3 days")).toBeTruthy();
    expect(screen.getByText("Expires in 1 day")).toBeTruthy();
    expect(screen.getByText("No expiry")).toBeTruthy();
  });

  it("explains an empty memory", () => {
    render(<LoopMemoryList notes={[]} />);
    expect(screen.getByText("No memory yet")).toBeTruthy();
  });
});
