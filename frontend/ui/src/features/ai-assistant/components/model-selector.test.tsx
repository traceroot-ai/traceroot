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
  isPending: false,
  onChange: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.models, isPending: mocks.isPending }),
}));

vi.mock("@/lib/api", () => ({
  getAvailableLLMModels: vi.fn(),
}));

import { ModelSelector } from "./model-selector";

afterEach(() => {
  cleanup();
  mocks.models = undefined;
  mocks.isPending = false;
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

  it("does not auto-pick a default while the query is still pending", () => {
    // While pending, models resolves to the compiled-in fallback list (non-empty),
    // but the selector must not auto-pick from it — only once settled.
    mocks.models = undefined;
    mocks.isPending = true;

    render(
      <ModelSelector
        value={{ model: "", provider: "", source: "system", adapter: "" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByRole("button").textContent).toContain("Select model");
    expect(mocks.onChange).not.toHaveBeenCalled();
  });

  it("does not clobber an existing selection once the query settles with zero models", () => {
    mocks.models = { byokProviders: [], systemModels: [] };
    mocks.isPending = false;

    render(
      <ModelSelector
        value={{
          model: "claude-opus-4-8",
          provider: "anthropic",
          source: "system",
          adapter: "anthropic",
        }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
      />,
    );

    expect(mocks.onChange).not.toHaveBeenCalled();
  });

  it("links to workspace model-provider settings from the empty dropdown state", () => {
    mocks.models = { byokProviders: [], systemModels: [] };

    render(
      <ModelSelector
        value={{ model: "", provider: "", source: "system", adapter: "" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    const link = screen.getByRole("link", { name: "configure one" });
    expect(link.getAttribute("href")).toBe("/workspaces/workspace-1/settings/model-providers");
  });

  it("shows 'Select model' placeholder when no model is selected and no models exist", () => {
    mocks.models = { byokProviders: [], systemModels: [] };

    render(
      <ModelSelector
        value={{ model: "", provider: "", source: "system", adapter: "" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByRole("button").textContent).toContain("Select model");
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
});
