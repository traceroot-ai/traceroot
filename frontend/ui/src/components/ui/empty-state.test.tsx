// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EmptyState } from "./empty-state";

afterEach(cleanup);

describe("EmptyState", () => {
  it("says what is missing, why it matters and offers the next step", () => {
    render(
      <EmptyState
        title="No detectors yet"
        description="Create a detector to automatically analyze your traces."
        action={<button>New detector</button>}
      />,
    );
    expect(screen.getByText("No detectors yet")).toBeTruthy();
    expect(
      screen.getByText("Create a detector to automatically analyze your traces."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "New detector" })).toBeTruthy();
  });

  it("draws the decorative pixel mark", () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    expect(container.querySelector("svg[aria-hidden='true']")).not.toBeNull();
  });
});
