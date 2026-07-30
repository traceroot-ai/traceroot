// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  projectData: undefined as { workspace_id: string } | undefined,
  llmModels: undefined as
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
  onClose: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "project") return { data: mocks.projectData };
    if (queryKey[0] === "llm-models") return { data: mocks.llmModels };
    return { data: undefined };
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
    setHistoryOpen: vi.fn(),
    handleSend: vi.fn(),
    handleAbort: vi.fn(),
    handleNewSession: vi.fn(),
    handleClose: vi.fn(),
    handleOpenHistory: vi.fn(),
    handleSelectSession: vi.fn(),
    handleDeleteSession: vi.fn(),
  }),
}));

vi.mock("./message-list", () => ({ MessageList: () => null }));
vi.mock("./message-input", () => ({ MessageInput: () => null }));
vi.mock("./session-history", () => ({ SessionHistory: () => null }));

import { AiAssistantPanel } from "./ai-assistant-panel";

afterEach(() => {
  cleanup();
  mocks.projectData = undefined;
  mocks.llmModels = undefined;
  mocks.onClose.mockReset();
});

describe("AiAssistantPanel", () => {
  it("renders a clickable link to model providers in the no-models empty state", () => {
    mocks.projectData = { workspace_id: "ws-abc" };
    mocks.llmModels = { systemModels: [], byokProviders: [] };

    render(<AiAssistantPanel projectId="proj-1" onClose={mocks.onClose} />);

    const link = screen.getByRole("link", { name: /Workspace Settings.*Model Providers/i });
    expect(link.getAttribute("href")).toBe("/workspaces/ws-abc/settings/model-providers");
  });
});
