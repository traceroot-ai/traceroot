// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SignalStatusBadge } from "./signal-status-badge";

afterEach(cleanup);

describe("SignalStatusBadge", () => {
  it.each([
    ["open", "Open", "text-warning"],
    ["resolved", "Resolved", "text-success"],
    ["dismissed", "Dismissed", "text-muted-foreground"],
  ] as const)("shows %s as a toned badge", (status, label, tone) => {
    render(<SignalStatusBadge status={status} />);
    const badge = screen.getByText(label);
    expect(badge.className).toContain(tone);
    expect(badge.getAttribute("data-status")).toBe(status);
  });
});
