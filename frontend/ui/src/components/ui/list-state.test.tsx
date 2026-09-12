// @vitest-environment jsdom
import { describe, expect, it, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  ListState,
  ListError,
  ListLoading,
  TableStateRow,
  LIST_ERROR_API_HINT,
} from "./list-state";

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

  it("keeps the headline muted and announces nothing by default", () => {
    render(<ListState title="No rows" />);

    expect(screen.getByText("No rows").className).toContain("text-muted-foreground");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reds the headline and announces the block when the tone is error", () => {
    render(<ListState tone="error" title="Error loading traces" />);

    const title = screen.getByText("Error loading traces");
    expect(title.className).toContain("text-destructive");
    expect(title.className).not.toContain("text-muted-foreground");
    expect(screen.getByRole("alert").contains(title)).toBe(true);
  });
});

describe("ListError", () => {
  it("renders a red announced headline, the shared hint and a retry", () => {
    const onRetry = vi.fn();
    render(<ListError title="Error loading runs" onRetry={onRetry} />);

    const title = screen.getByText("Error loading runs");
    expect(title.className).toContain("text-destructive");
    expect(screen.getByRole("alert").contains(title)).toBe(true);
    expect(screen.getByText(LIST_ERROR_API_HINT)).toBeTruthy();
    expect(screen.getByRole("alert").querySelector("svg")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("takes a caller description in place of the API-key hint", () => {
    render(
      <ListError
        title="Error loading users"
        description="Make sure the API server is running."
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("Make sure the API server is running.")).toBeTruthy();
    expect(screen.queryByText(LIST_ERROR_API_HINT)).toBeNull();
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
