// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

const loops = vi.hoisted(() => ({
  runs: undefined as unknown,
  useLoopRuns: vi.fn(),
}));
const layout = vi.hoisted(() => ({ loopsEnabled: true }));
vi.mock("@/components/layout/app-layout", () => ({ useLayout: () => layout }));
vi.mock("../hooks/use-loops", () => ({
  useLoopRuns: (...args: unknown[]) => {
    loops.useLoopRuns(...args);
    return { data: loops.runs };
  },
}));

import { FoundInRuns } from "./found-in-runs";

afterEach(() => {
  cleanup();
  loops.runs = undefined;
  loops.useLoopRuns.mockClear();
  layout.loopsEnabled = true;
});

describe("FoundInRuns", () => {
  const seen = (seqs: number[], total = seqs.length) => {
    loops.runs = {
      data: seqs.map((seq) => ({ id: `run-${seq}`, seq })),
      meta: { page: 0, limit: 3, total },
    };
  };
  const renderRuns = () =>
    render(
      <FoundInRuns
        projectId="p1"
        loop={{ id: "loop-1", name: "Coding agents" }}
        signalId="sig-1"
      />,
    );
  const runLinks = () =>
    screen.getAllByRole("link").map((l) => [l.textContent, l.getAttribute("href")]);

  it("asks for the signal's latest three runs of its Loop", () => {
    seen([12]);
    renderRuns();
    expect(loops.useLoopRuns).toHaveBeenCalledWith(
      "p1",
      "loop-1",
      { signalId: "sig-1", limit: 3 },
      { enabled: true },
    );
  });

  it("reads and shows no runs where loops are switched off", () => {
    layout.loopsEnabled = false;
    seen([12]);
    expect(renderRuns().container.innerHTML).toBe("");
    expect(loops.useLoopRuns).toHaveBeenCalledWith(
      "p1",
      "loop-1",
      { signalId: "sig-1", limit: 3 },
      { enabled: false },
    );
  });

  it("renders nothing before any run is linked", () => {
    seen([]);
    expect(renderRuns().container.innerHTML).toBe("");
  });

  it("names the one run that found it, linking to its transcript", () => {
    seen([12]);
    const { container } = renderRuns();
    expect(container.textContent).toBe("Seen in run #12");
    expect(runLinks()).toEqual([["#12", "/projects/p1/loops/loop-1?run=run-12"]]);
    expect(screen.getByRole("link", { name: "Open run #12 of Coding agents" })).toBeTruthy();
  });

  it("counts every run from the total and names the latest three, newest first", () => {
    seen([12, 9, 7], 57);
    const { container } = renderRuns();
    expect(container.textContent).toBe("Seen in 57 runs · latest #12, #9, #7");
    expect(runLinks()).toEqual([
      ["#12", "/projects/p1/loops/loop-1?run=run-12"],
      ["#9", "/projects/p1/loops/loop-1?run=run-9"],
      ["#7", "/projects/p1/loops/loop-1?run=run-7"],
    ]);
  });

  it("names both runs when it was seen twice", () => {
    seen([12, 9]);
    expect(renderRuns().container.textContent).toBe("Seen in 2 runs · latest #12, #9");
  });
});
