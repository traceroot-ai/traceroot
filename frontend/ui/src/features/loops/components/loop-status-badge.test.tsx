// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { LoopStatusBadge } from "./loop-status-badge";

afterEach(cleanup);

describe("LoopStatusBadge", () => {
  it("labels Active and Paused as plain text with no popover", () => {
    render(<LoopStatusBadge status="active" failureStreak={0} />);
    expect(screen.getByText("Active").tagName).toBe("SPAN");
    cleanup();
    render(<LoopStatusBadge status="paused" failureStreak={0} />);
    expect(screen.getByText("Paused").tagName).toBe("SPAN");
  });

  it("makes Paused by system a button that explains the reason", () => {
    render(<LoopStatusBadge status="paused_by_system" failureStreak={5} />);
    const badge = screen.getByRole("button", { name: "Paused by system" });
    fireEvent.click(badge);
    expect(screen.getByText(/5 scheduled runs in a row failed/)).toBeTruthy();
  });

  it("keeps clicks on the badge and its reason from reaching a clickable row", () => {
    let rowClicks = 0;
    render(
      <div onClick={() => rowClicks++}>
        <LoopStatusBadge status="paused_by_system" failureStreak={5} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Paused by system" }));
    fireEvent.click(screen.getByText(/5 scheduled runs in a row failed/));
    expect(rowClicks).toBe(0);
  });
});
