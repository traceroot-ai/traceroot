// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  models: undefined as
    | {
        systemModels: Array<{
          provider: string;
          adapter: string;
          source: "system";
          models: Array<{ id: string; label: string; supported?: boolean }>;
        }>;
        byokProviders: Array<{
          provider: string;
          adapter: string;
          source: "byok";
          models: Array<{ id: string; label: string; supported?: boolean }>;
        }>;
      }
    | undefined,
  onChange: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.models }),
}));

vi.mock("@/lib/api", () => ({
  getAvailableLLMModels: vi.fn(),
}));

import { ModelSelector } from "./model-selector";

afterEach(() => {
  cleanup();
  mocks.models = undefined;
  mocks.onChange.mockReset();
});

describe("ModelSelector", () => {
  it("preserves a saved but unmatched selection instead of auto-picking a default", () => {
    mocks.models = {
      byokProviders: [],
      systemModels: [
        {
          provider: "anthropic",
          adapter: "anthropic",
          source: "system",
          models: [{ id: "claude-4", label: "Claude 4" }],
        },
      ],
    };

    render(
      <ModelSelector
        value={{ model: "local-llm", provider: "local", source: "byok", adapter: "openai" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByRole("button").textContent).toContain("local-llm");
    expect(mocks.onChange).not.toHaveBeenCalled();
  });

  it("auto-picks a default only when the model is empty", () => {
    mocks.models = {
      byokProviders: [],
      systemModels: [
        {
          provider: "anthropic",
          adapter: "anthropic",
          source: "system",
          models: [{ id: "claude-4", label: "Claude 4" }],
        },
      ],
    };

    render(
      <ModelSelector
        value={{ model: "", provider: "", source: "system", adapter: "" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
      />,
    );

    expect(mocks.onChange).toHaveBeenCalledWith({
      model: "claude-4",
      provider: "anthropic",
      source: "system",
      adapter: "anthropic",
    });
  });

  it("renders the selected model indicator as an icon instead of a Unicode checkmark", () => {
    mocks.models = {
      byokProviders: [],
      systemModels: [
        {
          provider: "anthropic",
          adapter: "anthropic",
          source: "system",
          models: [
            { id: "claude-4", label: "Claude 4" },
            { id: "claude-3-5", label: "Claude 3.5" },
          ],
        },
      ],
    };

    render(
      <ModelSelector
        value={{
          model: "claude-4",
          provider: "anthropic",
          source: "system",
          adapter: "anthropic",
        }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /claude 4/i }));

    const selectedOption = screen
      .getAllByRole("button", { name: /claude 4/i })
      .find((button) => button.className.includes("w-full"));
    expect(selectedOption).toBeDefined();

    expect(selectedOption.textContent).not.toContain("✓");
    expect(selectedOption.querySelector("svg")).not.toBeNull();
  });
});
