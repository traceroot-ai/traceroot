// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

type MockAvailableModels = {
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
};

const mocks = vi.hoisted(() => ({
  project: { workspace_id: "workspace-1" } as { workspace_id: string } | undefined,
  projectLoading: false,
  projectError: false,
  llmModels: undefined as MockAvailableModels | undefined,
  modelsLoading: false,
  modelsError: false,
  handleSend: vi.fn(),
  handleAbort: vi.fn(),
  handleNewSession: vi.fn(),
  handleClose: vi.fn(),
  handleOpenHistory: vi.fn(),
  handleSelectSession: vi.fn(),
  handleDeleteSession: vi.fn(),
  setHistoryOpen: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === "project") {
      return {
        data: mocks.project,
        isLoading: mocks.projectLoading,
        isError: mocks.projectError,
      };
    }

    if (queryKey[0] === "llm-models") {
      return {
        data: mocks.llmModels,
        isLoading: mocks.modelsLoading,
        isError: mocks.modelsError,
      };
    }

    return { data: undefined, isLoading: false, isError: false };
  },
}));

vi.mock("@/lib/api", () => ({
  getProject: vi.fn(),
  getAvailableLLMModels: vi.fn(),
}));

vi.mock("./ai-chat-context", () => ({
  useAiChatContext: () => ({
    messages: [],
    isStreaming: false,
    sessions: [],
    historyOpen: false,
    currentSessionId: null,
    setHistoryOpen: mocks.setHistoryOpen,
    handleSend: mocks.handleSend,
    handleAbort: mocks.handleAbort,
    handleNewSession: mocks.handleNewSession,
    handleClose: mocks.handleClose,
    handleOpenHistory: mocks.handleOpenHistory,
    handleSelectSession: mocks.handleSelectSession,
    handleDeleteSession: mocks.handleDeleteSession,
  }),
}));

vi.mock("./message-list", () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

vi.mock("./message-input", () => ({
  MessageInput: ({ disabled, workspaceId }: { disabled?: boolean; workspaceId?: string }) => (
    <div
      data-disabled={String(Boolean(disabled))}
      data-testid="message-input"
      data-workspace-id={workspaceId ?? ""}
    />
  ),
}));

vi.mock("./session-history", () => ({
  SessionHistory: () => <div data-testid="session-history" />,
}));

import { AiAssistantPanel } from "./ai-assistant-panel";

function renderPanel() {
  return render(<AiAssistantPanel projectId="project-1" onClose={vi.fn()} />);
}

afterEach(() => {
  cleanup();
  mocks.project = { workspace_id: "workspace-1" };
  mocks.projectLoading = false;
  mocks.projectError = false;
  mocks.llmModels = undefined;
  mocks.modelsLoading = false;
  mocks.modelsError = false;
  mocks.handleSend.mockReset();
  mocks.handleAbort.mockReset();
  mocks.handleNewSession.mockReset();
  mocks.handleClose.mockReset();
  mocks.handleOpenHistory.mockReset();
  mocks.handleSelectSession.mockReset();
  mocks.handleDeleteSession.mockReset();
  mocks.setHistoryOpen.mockReset();
});

describe("AiAssistantPanel", () => {
  it("disables input until the project workspace is known", () => {
    mocks.project = undefined;
    mocks.projectLoading = true;

    renderPanel();

    expect(screen.getByText("Loading LLM models...")).toBeDefined();
    expect(screen.queryByTestId("message-list")).toBeNull();
    expect(screen.getByTestId("message-input").getAttribute("data-disabled")).toBe("true");
    expect(screen.getByTestId("message-input").getAttribute("data-workspace-id")).toBe("");
  });

  it("shows a loading state and disables input while workspace models are loading", () => {
    mocks.modelsLoading = true;

    renderPanel();

    expect(screen.getByText("Loading LLM models...")).toBeDefined();
    expect(screen.getByText("Checking the models available to this workspace.")).toBeDefined();
    expect(screen.queryByTestId("message-list")).toBeNull();
    expect(screen.getByTestId("message-input").getAttribute("data-disabled")).toBe("true");
  });

  it("shows a recovery state and disables input when workspace models fail to load", () => {
    mocks.modelsError = true;

    renderPanel();

    expect(screen.getByText("Unable to load LLM models")).toBeDefined();
    expect(
      screen.getByText(/model provider settings or server API-key configuration/),
    ).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Configure model providers" }).getAttribute("href"),
    ).toBe("/workspaces/workspace-1/settings/model-providers");
    expect(screen.queryByTestId("message-list")).toBeNull();
    expect(screen.getByTestId("message-input").getAttribute("data-disabled")).toBe("true");
  });

  it("shows an empty state and disables input when no workspace models are configured", () => {
    mocks.llmModels = { systemModels: [], byokProviders: [] };

    renderPanel();

    expect(screen.getByText("No LLM models available")).toBeDefined();
    expect(screen.getByText(/Workspace Settings/)).toBeDefined();
    expect(screen.queryByTestId("message-list")).toBeNull();
    expect(screen.getByTestId("message-input").getAttribute("data-disabled")).toBe("true");
  });

  it("does not enable input when only unsupported BYOK models are configured", () => {
    mocks.llmModels = {
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

    renderPanel();

    expect(screen.queryByText("Unsupported model detected")).toBeNull();
    expect(screen.getByText("No supported LLM models available")).toBeDefined();
    expect(
      screen.getByText(/none of its models are currently supported by Traceroot/),
    ).toBeDefined();
    expect(screen.queryByTestId("message-list")).toBeNull();
    expect(screen.getByTestId("message-input").getAttribute("data-disabled")).toBe("true");
  });

  it("shows messages and enables input when at least one workspace model is available", () => {
    mocks.llmModels = {
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

    renderPanel();

    expect(screen.getByTestId("message-list")).toBeDefined();
    expect(screen.getByTestId("message-input").getAttribute("data-disabled")).toBe("false");
    expect(screen.getByTestId("message-input").getAttribute("data-workspace-id")).toBe(
      "workspace-1",
    );
  });
});
