// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModelSelector, type ModelSelection } from "./model-selector";

const mocks = vi.hoisted(() => ({
  data: {
    systemModels: [
      {
        provider: "openai",
        adapter: "openai",
        models: [{ id: "gpt-4o-mini", label: "GPT-4o mini" }],
      },
    ],
    byokProviders: [],
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.data }),
}));

const selected: ModelSelection = {
  model: "gpt-4o-mini",
  provider: "openai",
  source: "system",
  adapter: "openai",
};

afterEach(() => cleanup());

describe("ModelSelector", () => {
  it("renders disabled without opening or backfilling selection", async () => {
    const onChange = vi.fn();

    render(
      <ModelSelector
        workspaceId="ws-1"
        value={{ ...selected, adapter: "" }}
        onChange={onChange}
        disabled
      />,
    );

    const trigger = screen.getByRole("button", { name: /gpt-4o mini/i });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(trigger);
    expect(screen.queryByRole("button", { name: /gpt-4o mini/i })).toBe(trigger);
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());
  });
});
