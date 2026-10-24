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

/**
 * The group filters. They are toggle buttons rather than ARIA tabs, and they
 * are the only buttons in here -- the cards are radios and the two requests
 * are links.
 */
function filters(): HTMLElement[] {
  return screen.getAllByRole("button");
}

function pressFilter(label: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

function search(value: string) {
  fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value } });
}

describe("the group filters", () => {
  it("offers All plus one filter per group, with All pressed first", () => {
    renderSelector();
    expect(filters().map((filter) => filter.textContent)).toEqual([
      "All",
      "Model providers",
      "SDK integrations",
      "Agent frameworks",
    ]);
    // Pressed rather than selected: filtering the list is not choosing from it,
    // and these control no tabpanel.
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows every entry under All, grouped and labelled", () => {
    renderSelector();
    expect(cardNames()).toHaveLength(INTEGRATIONS.length);
    for (const label of ["Model providers", "SDK integrations", "Agent frameworks"]) {
      // Both the filter and the heading carry the words, so the heading is the
      // second of the two.
      expect(screen.getAllByText(label).length).toBeGreaterThan(1);
    }
  });

  it("shows only the model providers under Model providers", () => {
    renderSelector();
    pressFilter("Model providers");
    expect(cardNames()).toEqual(["Anthropic", "Google Gemini", "Mistral", "OpenAI", "OpenRouter"]);
  });

  it("shows only the SDKs under SDK integrations", () => {
    renderSelector();
    pressFilter("SDK integrations");
    expect(cardNames()).toEqual(["DSPy", "LlamaIndex", "pi SDK", "Vercel AI SDK"]);
  });

  it("shows only the agent frameworks under Agent frameworks", () => {
    renderSelector();
    pressFilter("Agent frameworks");
    expect(cardNames()).toEqual([
      "Agno",
      "AutoGen",
      "Claude Agent SDK",
      "CrewAI",
      "Google ADK",
      "LangChain & LangGraph",
      "LangChain DeepAgents",
      "Microsoft Agent Framework",
      "Mastra",
      "OpenAI Agents SDK",
      "Pydantic AI",
    ]);
  });

  it("drops the group heading once the filter already says it", () => {
    renderSelector();
    pressFilter("SDK integrations");
    // Only the filter is left carrying the words.
    expect(screen.getAllByText("SDK integrations")).toHaveLength(1);
    expect(screen.queryByText("Agent frameworks")).toBeTruthy(); // still a filter
    expect(screen.getAllByText("Agent frameworks")).toHaveLength(1);
  });
});

describe("the search", () => {
  it("narrows the cards to the matches", () => {
    renderSelector();
    search("lang");
    expect(cardNames()).toEqual(["LangChain & LangGraph", "LangChain DeepAgents"]);
  });

  it("finds an entry by a name the card does not show", () => {
    // The ids are hyphenated where the displayed names are spaced, so
    // "langchain-deepagents" matches on the id alone -- "deepagents" and
    // "langgraph" would both be found by the name on the card and so would
    // prove nothing about the id.
    renderSelector();
    search("langchain-deepagents");
    expect(cardNames()).toEqual(["LangChain DeepAgents"]);
  });

  it("applies on top of the selected group rather than replacing it", () => {
    renderSelector();
    pressFilter("Model providers");
    search("openai");
    expect(cardNames()).toEqual(["OpenAI"]);
    pressFilter("Agent frameworks");
    expect(cardNames()).toEqual(["OpenAI Agents SDK"]);
  });

  it("says nothing matched, and offers the request link, rather than falling back", () => {
    renderSelector();
    search("cobol");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByText(/Nothing in this list matches that/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "request the integration" })).toBeTruthy();
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

  it("does not change the selection when a filter hides it", () => {
    // Reading the list is not choosing from it: the snippets and the key field
    // below must not move for someone who is only looking something up.
    const { onSelect } = renderSelector("crewai");
    search("mastra");
    expect(cardNames()).toEqual(["Mastra"]);
    expect(onSelect).not.toHaveBeenCalled();
    pressFilter("Model providers");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
