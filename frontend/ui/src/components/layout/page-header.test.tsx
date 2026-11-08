// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PageHeader } from "./page-header";

afterEach(cleanup);

describe("PageHeader", () => {
  it("renders the page title as the h1", () => {
    render(<PageHeader title="Detectors" />);
    expect(screen.getByRole("heading", { level: 1, name: "Detectors" })).toBeTruthy();
  });

  it("shows an optional description and the actions on the right", () => {
    render(
      <PageHeader
        title="Evaluations"
        description="Compare runs of your agent against datasets."
        actions={<button>New thing</button>}
      />,
    );
    expect(screen.getByText("Compare runs of your agent against datasets.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New thing" })).toBeTruthy();
  });

  it("wraps instead of overflowing so a narrow screen stacks title and actions", () => {
    const { container } = render(
      <PageHeader title="Alerts" actions={<button>New alert</button>} />,
    );
    const header = container.firstElementChild as HTMLElement;
    expect(header.className).toContain("flex-wrap");
    expect(header.className).toContain("border-b");
  });

  it("omits the actions slot when there are none", () => {
    const { container } = render(<PageHeader title="Signals" />);
    expect(container.querySelectorAll("[data-slot=actions]")).toHaveLength(0);
  });
});
