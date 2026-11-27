// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  state: { isPending: false, isError: false, error: null as Error | null },
}));
vi.mock("../hooks/use-loops", () => ({
  useRunLoop: () => ({ mutate: mocks.mutate, ...mocks.state }),
}));

import {
  LOOP_RUN_IN_PROGRESS,
  LOOP_RUN_PAUSED,
  LOOP_RUN_PLAN_BLOCKED,
} from "@traceroot/core/loops/pure";
import { RunLoop } from "./run-loop";

afterEach(() => {
  cleanup();
  mocks.mutate.mockReset();
  mocks.state = { isPending: false, isError: false, error: null };
});

describe("RunLoop", () => {
  it("queues a run on click", () => {
    render(<RunLoop projectId="p1" loopId="l1" active={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  it("is disabled, and says why, while a run is queued or running", () => {
    render(<RunLoop projectId="p1" loopId="l1" active={true} />);
    const button = screen.getByRole("button", { name: "Run queued" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.parentElement?.title).toBe(LOOP_RUN_IN_PROGRESS);
  });

  it("is disabled, and says why, when the plan's loop runs are used up", () => {
    render(<RunLoop projectId="p1" loopId="l1" active={false} planBlocked />);
    const button = screen.getByRole("button", { name: "Run now" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.parentElement?.title).toBe(LOOP_RUN_PLAN_BLOCKED);
    fireEvent.click(button);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("is disabled, and says why, while the loop is paused", () => {
    render(<RunLoop projectId="p1" loopId="l1" active={false} paused />);
    const button = screen.getByRole("button", { name: "Run now" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.parentElement?.title).toBe(LOOP_RUN_PAUSED);
  });

  it("says Running once the active run has started", () => {
    render(<RunLoop projectId="p1" loopId="l1" active running />);
    const button = screen.getByRole("button", { name: "Running…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.parentElement?.title).toBe(LOOP_RUN_IN_PROGRESS);
    expect(screen.queryByRole("button", { name: "Run queued" })).toBeNull();
  });

  it("names an active run before the plan or a pause", () => {
    render(<RunLoop projectId="p1" loopId="l1" active planBlocked paused />);
    expect(screen.getByRole("button", { name: "Run queued" }).parentElement?.title).toBe(
      LOOP_RUN_IN_PROGRESS,
    );
  });

  it("names a pause before the plan, as the run route does", () => {
    render(<RunLoop projectId="p1" loopId="l1" active={false} planBlocked paused />);
    expect(screen.getByRole("button", { name: "Run now" }).parentElement?.title).toBe(
      LOOP_RUN_PAUSED,
    );
  });

  it("has no reason when it can run", () => {
    render(
      <RunLoop projectId="p1" loopId="l1" active={false} planBlocked={false} paused={false} />,
    );
    const button = screen.getByRole("button", { name: "Run now" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.parentElement?.hasAttribute("title")).toBe(false);
  });

  it("is disabled while the request is in flight", () => {
    mocks.state.isPending = true;
    render(<RunLoop projectId="p1" loopId="l1" active={false} />);
    expect((screen.getByRole("button", { name: "Run queued" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("shows the route's refusal", () => {
    mocks.state = {
      isPending: false,
      isError: true,
      error: new Error("This loop already has a run in progress"),
    };
    render(<RunLoop projectId="p1" loopId="l1" active={false} />);
    expect(screen.getByRole("alert").textContent).toBe("This loop already has a run in progress");
  });
});
