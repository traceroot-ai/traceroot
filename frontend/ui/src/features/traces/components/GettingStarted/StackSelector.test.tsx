// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { INTEGRATIONS } from "./integrations";
import { StackSelector } from "./StackSelector";

afterEach(cleanup);

const byId = (id: string) => INTEGRATIONS.find((integration) => integration.id === id)!;

function renderSelector(selectedId = "openai") {
  const onSelect = vi.fn();
  return {
    onSelect,
    ...render(<StackSelector selected={byId(selectedId)} onSelect={onSelect} />),
  };
}

/** The names on the cards currently on screen, in the order they are rendered. */
function cardNames(): string[] {
  return screen.getAllByRole("radio").map((card) => card.textContent ?? "");
}

describe("the list", () => {
  it("shows every entry at once, under two headings and behind no filter", () => {
    renderSelector();
    expect(cardNames()).toHaveLength(INTEGRATIONS.length);
    expect(screen.getByText("Model providers")).toBeTruthy();
    expect(screen.getByText("Frameworks & SDKs")).toBeTruthy();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    // Nor as toggle buttons, which is the shape the group filters last had:
    // the cards are radios and the request is a link, so a button here would
    // be a filter coming back.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByLabelText("Search integrations")).toBeNull();
  });
});

describe("the selection", () => {
  it("marks the selected card and only that one", () => {
    renderSelector("crewai");
    const checked = screen
      .getAllByRole("radio")
      .filter((c) => c.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0].textContent).toBe("CrewAI");
  });

  it("reports the id of a pressed card", () => {
    const { onSelect } = renderSelector();
    fireEvent.click(screen.getByRole("radio", { name: "Mastra" }));
    expect(onSelect).toHaveBeenCalledWith("mastra");
  });
});
