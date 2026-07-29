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

  it("does not backfill a provider onto a partially-hydrated selection while pending", () => {
    // A legacy row (e.g. project.rca_model set, rca_provider NULL) arrives as a
    // model-id-only selection. While the query is pending, `models` is the
    // compiled-in fallback list, which DOES contain this id — so the reconcile
    // effect must not run yet, or it would backfill provider="Anthropic" the
    // user never chose and self-enable Save. It reconciles once settled.
    mocks.models = undefined;
    mocks.isPending = true;

    render(
      <ModelSelector
        value={{ model: "claude-opus-4-8", provider: "", source: "system", adapter: "" }}
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

  it("does not auto-pick when a defaultModelId marks empty as a valid state", () => {
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
        defaultModelId="claude-4"
      />,
    );

    expect(mocks.onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button").textContent).toContain("Claude 4");
  });

  it("ticks the tracked default so an empty selection reads as a real pick", () => {
    mocks.models = {
      byokProviders: [],
      systemModels: [
        {
          provider: "anthropic",
          adapter: "anthropic",
          source: "system",
          models: [
            { id: "claude-4", label: "Claude 4" },
            { id: "claude-5", label: "Claude 5" },
          ],
        },
      ],
    };

    render(
      <ModelSelector
        value={{ model: "", provider: "", source: "system", adapter: "" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
        defaultModelId="claude-4"
      />,
    );
    fireEvent.click(screen.getByRole("button"));

    // The popover trigger repeats the selected label, so exclude it.
    const rows = screen.getAllByRole("button").filter((b) => !b.hasAttribute("aria-haspopup"));
    const tracked = rows.find((b) => b.textContent?.includes("Claude 4"));
    const other = rows.find((b) => b.textContent?.includes("Claude 5"));
    expect(tracked?.textContent).toContain("✓");
    expect(other?.textContent).not.toContain("✓");
  });

  it("picking the tracked default keeps the selection empty rather than pinning it", () => {
    mocks.models = {
      byokProviders: [],
      systemModels: [
        {
          provider: "anthropic",
          adapter: "anthropic",
          source: "system",
          models: [
            { id: "claude-4", label: "Claude 4" },
            { id: "claude-5", label: "Claude 5" },
          ],
        },
      ],
    };

    render(
      <ModelSelector
        value={{ model: "", provider: "", source: "system", adapter: "" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
        defaultModelId="claude-4"
      />,
    );
    fireEvent.click(screen.getByRole("button"));

    const rows = screen.getAllByRole("button").filter((b) => !b.hasAttribute("aria-haspopup"));
    fireEvent.click(rows.find((b) => b.textContent?.includes("Claude 4"))!);
    expect(mocks.onChange).not.toHaveBeenCalled();

    // Any other row is a real pick and still writes a selection.
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(
      screen
        .getAllByRole("button")
        .filter((b) => !b.hasAttribute("aria-haspopup"))
        .find((b) => b.textContent?.includes("Claude 5"))!,
    );
    expect(mocks.onChange).toHaveBeenCalledWith({
      model: "claude-5",
      provider: "anthropic",
      source: "system",
      adapter: "anthropic",
    });
  });

  // The suppression above applies only while the selection is empty, so a
  // parent that moved off the default can always move back to it.
  it("selects the default model normally once something else is pinned", () => {
    mocks.models = {
      byokProviders: [],
      systemModels: [
        {
          provider: "anthropic",
          adapter: "anthropic",
          source: "system",
          models: [
            { id: "claude-4", label: "Claude 4" },
            { id: "claude-5", label: "Claude 5" },
          ],
        },
      ],
    };

    render(
      <ModelSelector
        value={{ model: "claude-5", provider: "anthropic", source: "system", adapter: "anthropic" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
        defaultModelId="claude-4"
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(
      screen
        .getAllByRole("button")
        .filter((b) => !b.hasAttribute("aria-haspopup"))
        .find((b) => b.textContent?.includes("Claude 4"))!,
    );

    expect(mocks.onChange).toHaveBeenCalledWith({
      model: "claude-4",
      provider: "anthropic",
      source: "system",
      adapter: "anthropic",
    });
  });

  // A BYOK detector with no model runs that provider's own model, so showing
  // it the system default would name a model that will not run.
  it("does not present the default to a BYOK selection with no model", () => {
    mocks.models = {
      byokProviders: [
        {
          provider: "My OpenAI",
          adapter: "openai",
          source: "byok",
          models: [{ id: "gpt-5", label: "GPT-5", supported: true }],
        },
      ],
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
        value={{ model: "", provider: "My OpenAI", source: "byok", adapter: "openai" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
        defaultModelId="claude-4"
      />,
    );

    expect(screen.getByRole("button").textContent).toContain("Select model");
    expect(screen.getByRole("button").textContent).not.toContain("Claude 4");

    fireEvent.click(screen.getByRole("button"));
    const ticked = screen.getAllByRole("button").filter((b) => b.textContent?.includes("✓"));
    expect(ticked).toHaveLength(0);
  });

  // The catalog lists BYOK first and is not deduplicated, so an id-only match
  // must not bind a system selection to a BYOK provider's credentials.
  it("backfills a model-only selection from its own source, not the first row", () => {
    mocks.models = {
      byokProviders: [
        {
          provider: "My Anthropic",
          adapter: "anthropic",
          source: "byok",
          models: [{ id: "claude-4", label: "Claude 4", supported: true }],
        },
      ],
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
        value={{ model: "claude-4", provider: "", source: "system", adapter: "" }}
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

  // The source-preferring match must still fall back: a legacy hydrated
  // selection (model id only, no provider) may name a model that exists only
  // under BYOK, and dropping the fallback would stop backfilling it.
  it("falls back across sources when the id exists under no other", () => {
    mocks.models = {
      byokProviders: [
        {
          provider: "My LLM",
          adapter: "openai",
          source: "byok",
          models: [{ id: "custom-llm", label: "Custom LLM", supported: true }],
        },
      ],
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
        value={{ model: "custom-llm", provider: "", source: "system", adapter: "" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
      />,
    );

    expect(mocks.onChange).toHaveBeenCalledWith({
      model: "custom-llm",
      provider: "My LLM",
      source: "byok",
      adapter: "openai",
    });
  });

  // A BYOK provider may expose the same model id as the system default; that
  // is a separate row and picking it stores a different selection, so only
  // the system row is the tracked default.
  it("ticks only the system row when a BYOK provider exposes the same id", () => {
    mocks.models = {
      byokProviders: [
        {
          provider: "My Anthropic",
          adapter: "anthropic",
          source: "byok",
          models: [{ id: "claude-4", label: "Claude 4", supported: true }],
        },
      ],
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
        defaultModelId="claude-4"
      />,
    );
    fireEvent.click(screen.getByRole("button"));

    const ticked = screen
      .getAllByRole("button")
      .filter((b) => b.textContent?.includes("✓") && b.textContent?.includes("Claude 4"));
    expect(ticked).toHaveLength(1);
    // The BYOK row is the one carrying the provider tag.
    expect(ticked[0].textContent).not.toContain("My Anthropic");
  });

  it("still backfills a legacy model-only selection when a defaultModelId is set", () => {
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
        value={{ model: "claude-4", provider: "", source: "system", adapter: "" }}
        onChange={mocks.onChange}
        workspaceId="workspace-1"
        defaultModelId="claude-4"
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
