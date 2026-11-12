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
    expect(button.title).toBe("This Loop already has a run in progress");
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
      error: new Error("This Loop already has a run in progress"),
    };
    render(<RunLoop projectId="p1" loopId="l1" active={false} />);
    expect(screen.getByRole("alert").textContent).toBe("This Loop already has a run in progress");
  });
});
