// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

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
  isLoading: false,
  isError: false,
  onChange: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: mocks.models,
    isLoading: mocks.isLoading,
    isError: mocks.isError,
  }),
}));

vi.mock("@/lib/api", () => ({
  getAvailableLLMModels: vi.fn(),
}));

import { ModelSelector } from "./model-selector";

afterEach(() => {
  cleanup();
  mocks.models = undefined;
  mocks.isLoading = false;
  mocks.isError = false;
  mocks.onChange.mockReset();
});

describe("ModelSelector", () => {
  it("does not use fallback system models before workspace model data is loaded", () => {
    mocks.models = undefined;
    mocks.isLoading = true;

    render(
      <ModelSelector
        value={{ model: "", provider: "", source: "system", adapter: "" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
        includeFallbackModels={false}
        hideUnsupportedModels
      />,
    );

    expect(screen.getByRole("button").textContent).toContain("Loading models...");
    expect(mocks.onChange).not.toHaveBeenCalled();
  });

  it("keeps fallback auto-selection for existing selector consumers by default", () => {
    mocks.models = undefined;
    mocks.isLoading = true;

    render(
      <ModelSelector
        value={{ model: "", provider: "", source: "system", adapter: "" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
      />,
    );

    expect(mocks.onChange).toHaveBeenCalledTimes(1);
    const selection = mocks.onChange.mock.calls[0][0];
    expect(selection.model).toBeTruthy();
    expect(selection.provider).toBeTruthy();
    expect(selection.adapter).toBeTruthy();
    expect(selection.source).toBe("system");
  });

  it("prefers a requested default model when it is available", () => {
    mocks.models = {
      byokProviders: [],
      systemModels: [
        {
          provider: "Anthropic",
          adapter: "anthropic",
          source: "system",
          models: [
            { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
            { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
          ],
        },
      ],
    };

    render(
      <ModelSelector
        value={{ model: "", provider: "", source: "system", adapter: "" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
        includeFallbackModels={false}
        hideUnsupportedModels
        preferredDefaultModelId="claude-haiku-4-5"
        preferredDefaultModelSource="system"
      />,
    );

    expect(mocks.onChange).toHaveBeenCalledWith({
      model: "claude-haiku-4-5",
      provider: "Anthropic",
      source: "system",
      adapter: "anthropic",
    });
  });

  it("prefers the first available requested default from a list", () => {
    mocks.models = {
      byokProviders: [],
      systemModels: [
        {
          provider: "OpenAI",
          adapter: "openai",
          source: "system",
          models: [
            { id: "gpt-5.5", label: "gpt-5.5" },
            { id: "gpt-5.4-mini", label: "gpt-5.4-mini" },
          ],
        },
      ],
    };

    render(
      <ModelSelector
        value={{ model: "", provider: "", source: "system", adapter: "" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
        includeFallbackModels={false}
        hideUnsupportedModels
        preferredDefaultModelIds={["claude-haiku-4-5", "gpt-5.4-mini"]}
        preferredDefaultModelSource="system"
      />,
    );

    expect(mocks.onChange).toHaveBeenCalledWith({
      model: "gpt-5.4-mini",
      provider: "OpenAI",
      source: "system",
      adapter: "openai",
    });
  });

  it("shows a load-error state without auto-picking fallback models", () => {
    mocks.models = undefined;
    mocks.isError = true;

    render(
      <ModelSelector
        value={{ model: "", provider: "", source: "system", adapter: "" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
        includeFallbackModels={false}
        hideUnsupportedModels
      />,
    );

    expect(screen.getByRole("button").textContent).toContain("Models unavailable");
    expect(mocks.onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText("Unable to load models")).toBeDefined();
    expect(screen.getByText("Refresh the page before selecting a model.")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Configure BYOK providers" })).toBeNull();
  });

  it("shows an empty-provider state without auto-picking when no models are configured", () => {
    mocks.models = {
      byokProviders: [],
      systemModels: [],
    };

    render(
      <ModelSelector
        value={{ model: "", provider: "", source: "system", adapter: "" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
        includeFallbackModels={false}
        hideUnsupportedModels
      />,
    );

    expect(screen.getByRole("button").textContent).toContain("No model configured");
    expect(mocks.onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getAllByText("No model configured").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "Self-hosted deployments need an admin to set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the server environment. To use a workspace-scoped key instead, add a BYOK provider.",
      ),
    ).toBeDefined();
    expect(screen.queryByText(/Claude/i)).toBeNull();
    expect(
      screen.getByRole("link", { name: "Configure BYOK providers" }).getAttribute("href"),
    ).toBe("/workspaces/workspace-1/settings/model-providers");
  });

  it("treats unsupported-only provider models as unavailable for interactive selection", () => {
    mocks.models = {
      systemModels: [],
      byokProviders: [
        {
          provider: "openai-compatible",
          adapter: "openai",
          source: "byok",
          models: [{ id: "legacy-local", label: "Legacy Local", supported: false }],
        },
      ],
    };

    render(
      <ModelSelector
        value={{ model: "", provider: "", source: "system", adapter: "" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
        includeFallbackModels={false}
        hideUnsupportedModels
      />,
    );

    expect(screen.getByRole("button").textContent).toContain("No supported models");
    expect(mocks.onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getAllByText("No supported models").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "A provider is configured, but none of its models are currently supported by Traceroot.",
      ),
    ).toBeDefined();
    expect(screen.getByRole("link", { name: "Open Model Providers" }).getAttribute("href")).toBe(
      "/workspaces/workspace-1/settings/model-providers",
    );
    expect(screen.queryByText("Legacy Local")).toBeNull();
  });

  it("keeps unsupported BYOK entries visible for existing selector consumers by default", () => {
    mocks.models = {
      systemModels: [],
      byokProviders: [
        {
          provider: "openai-compatible",
          adapter: "openai",
          source: "byok",
          models: [{ id: "legacy-local", label: "Legacy Local", supported: false }],
        },
      ],
    };

    render(
      <ModelSelector
        value={{ model: "", provider: "", source: "system", adapter: "" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
        includeFallbackModels={false}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText("Legacy Local")).toBeDefined();
    expect(screen.getByText("(unsupported)")).toBeDefined();
  });

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

  it("uses a non-submit trigger when rendered inside forms", () => {
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
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());

    render(
      <form onSubmit={onSubmit}>
        <ModelSelector
          value={{
            model: "claude-4",
            provider: "anthropic",
            source: "system",
            adapter: "anthropic",
          }}
          onChange={mocks.onChange}
          workspaceId="workspace-1"
        />
      </form>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Claude 4/i }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("prioritizes loaded unavailable states over stale saved model ids", () => {
    mocks.models = {
      byokProviders: [],
      systemModels: [],
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
        includeFallbackModels={false}
      />,
    );

    expect(screen.getByRole("button").textContent).toContain("No model configured");
    expect(screen.getByRole("button").textContent).not.toContain("claude-4");
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
