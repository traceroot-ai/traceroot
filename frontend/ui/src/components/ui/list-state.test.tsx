// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ListState, ListLoading, TableStateRow } from "./list-state";

afterEach(cleanup);

describe("ListState", () => {
  it("renders icon, title, description and action in order", () => {
    render(
      <ListState
        icon={<svg data-testid="icon" />}
        title="No items"
        description="Nothing here yet."
        action={<button type="button">Go</button>}
      />,
    );
    const title = screen.getByText("No items");
    expect(screen.getByTestId("icon")).toBeTruthy();
    expect(screen.getByText("Nothing here yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go" })).toBeTruthy();
    expect(title.parentElement?.querySelector("svg")).toBeTruthy();
  });

  it("renders just the title when nothing else is given", () => {
    render(<ListState title="No rows" />);
    expect(screen.getByText("No rows")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("ListLoading", () => {
  it("shows a labeled spinner", () => {
    render(<ListLoading label="Loading traces..." />);
    expect(screen.getByText("Loading traces...")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });
});

describe("TableStateRow", () => {
  it("spans every table column", () => {
    render(
      <table>
        <tbody>
          <TableStateRow colSpan={7}>
            <ListState title="Empty" />
          </TableStateRow>
        </tbody>
      </table>,
    );
    expect(screen.getByText("Empty").closest("td")?.colSpan).toBe(7);
  });
});