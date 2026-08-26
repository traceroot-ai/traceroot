// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { ExpandableSection } from "./expandable-section";

afterEach(() => cleanup());

describe("ExpandableSection", () => {
  it("renders its children open by default", () => {
    render(
      <ExpandableSection title="Input">
        <p>body</p>
      </ExpandableSection>,
    );
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("starts closed when defaultOpen is false", () => {
    render(
      <ExpandableSection title="Input" defaultOpen={false}>
        <p>body</p>
      </ExpandableSection>,
    );
    expect(screen.queryByText("body")).toBeNull();
  });

  it("toggles the body from the header", () => {
    render(
      <ExpandableSection title="Input">
        <p>body</p>
      </ExpandableSection>,
    );
    const header = screen.getByRole("button");
    fireEvent.click(header);
    expect(screen.queryByText("body")).toBeNull();
    fireEvent.click(header);
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("renders no copy affordance without an onCopy handler", () => {
    render(
      <ExpandableSection title="Input">
        <p>body</p>
      </ExpandableSection>,
    );
    expect(screen.queryByTitle("Copy")).toBeNull();
  });

  it("copies without collapsing the section", () => {
    const onCopy = vi.fn();
    render(
      <ExpandableSection title="Input" onCopy={onCopy}>
        <p>body</p>
      </ExpandableSection>,
    );
    fireEvent.click(screen.getByTitle("Copy"));
    expect(onCopy).toHaveBeenCalledTimes(1);
    // The click is stopped before it reaches the header button.
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("renders a header action whose clicks do not toggle the section", () => {
    const onAction = vi.fn();
    render(
      <ExpandableSection
        title="Input"
        headerAction={
          <span role="presentation" onClick={onAction}>
            Pretty
          </span>
        }
      >
        <p>body</p>
      </ExpandableSection>,
    );
    fireEvent.click(screen.getByText("Pretty"));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText("body")).toBeTruthy();
  });
});
