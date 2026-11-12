// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const loops = vi.hoisted(() => ({ map: new Map<string, { id: string; name: string }>() }));
vi.mock("../hooks/use-loops", () => ({ useLoopsByDetector: () => ({ data: loops.map }) }));

import { FoundByLoop } from "./found-by-loop";

afterEach(() => {
  cleanup();
  loops.map = new Map();
});

describe("FoundByLoop", () => {
  it("links a Loop's detector to the Loop", () => {
    loops.map = new Map([["det-1", { id: "loop-1", name: "Coding agents" }]]);
    render(<FoundByLoop projectId="p1" detectorId="det-1" />);
    expect(
      screen.getByRole("link", { name: /Found by Loop Coding agents/ }).getAttribute("href"),
    ).toBe("/projects/p1/loops/loop-1");
  });

  it("renders nothing for a detector that is not a Loop's", () => {
    loops.map = new Map([["det-1", { id: "loop-1", name: "Coding agents" }]]);
    const { container } = render(<FoundByLoop projectId="p1" detectorId="det-2" />);
    expect(container.innerHTML).toBe("");
  });

  it("passes the click to the caller, so a table row does not also open", () => {
    loops.map = new Map([["det-1", { id: "loop-1", name: "Coding agents" }]]);
    const onClick = vi.fn((e: React.MouseEvent) => e.preventDefault());
    render(<FoundByLoop projectId="p1" detectorId="det-1" onClick={onClick} />);
    fireEvent.click(screen.getByRole("link"));
    expect(onClick).toHaveBeenCalled();
  });
});
