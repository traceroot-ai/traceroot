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
  workspaceData: undefined as { role: string } | undefined,
  sessionHistoryCanDelete: undefined as boolean | undefined,
  sendError: null as string | null,
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

vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({ data: mocks.workspaceData }),
}));

vi.mock("./ai-chat-context", () => ({
  useAiChatContext: () => ({
    messages: [],
    isStreaming: false,
    sendError: mocks.sendError,
    sessions: [],
    historyOpen: true,
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
vi.mock("./session-history", () => ({
  SessionHistory: (props: { canDelete?: boolean }) => {
    mocks.sessionHistoryCanDelete = props.canDelete;
    return null;
  },
}));

import { AiAssistantPanel } from "./ai-assistant-panel";

afterEach(() => {
  cleanup();
  mocks.projectData = undefined;
  mocks.llmModels = undefined;
  mocks.workspaceData = undefined;
  mocks.sessionHistoryCanDelete = undefined;
  mocks.sendError = null;
  mocks.onClose.mockReset();
});

describe("AiAssistantPanel — canDelete passed to SessionHistory", () => {
  it("passes canDelete=true when current user is ADMIN", () => {
    mocks.projectData = { workspace_id: "ws-1" };
    mocks.llmModels = {
      systemModels: [
        {
          provider: "anthropic",
          adapter: "anthropic",
          source: "system",
          models: [{ id: "claude-4", label: "Claude 4" }],
        },
      ],
      byokProviders: [],
    };
    mocks.workspaceData = { role: "ADMIN" };

    render(<AiAssistantPanel projectId="proj-1" onClose={mocks.onClose} />);

    expect(mocks.sessionHistoryCanDelete).toBe(true);
  });

  it("passes canDelete=false when current user is MEMBER", () => {
    mocks.projectData = { workspace_id: "ws-1" };
    mocks.llmModels = {
      systemModels: [
        {
          provider: "anthropic",
          adapter: "anthropic",
          source: "system",
          models: [{ id: "claude-4", label: "Claude 4" }],
        },
      ],
      byokProviders: [],
    };
    mocks.workspaceData = { role: "MEMBER" };

    render(<AiAssistantPanel projectId="proj-1" onClose={mocks.onClose} />);

    expect(mocks.sessionHistoryCanDelete).toBe(false);
  });
});

describe("AiAssistantPanel — send/session-creation error", () => {
  it("surfaces sendError near the input instead of failing silently", () => {
    mocks.projectData = { workspace_id: "ws-1" };
    mocks.llmModels = {
      systemModels: [
        {
          provider: "anthropic",
          adapter: "anthropic",
          source: "system",
          models: [{ id: "claude-4", label: "Claude 4" }],
        },
      ],
      byokProviders: [],
    };
    mocks.workspaceData = { role: "MEMBER" };
    mocks.sendError = "Requires MEMBER role or higher";

    render(<AiAssistantPanel projectId="proj-1" onClose={mocks.onClose} />);

    expect(screen.getByText("Requires MEMBER role or higher")).toBeTruthy();
  });

  it("renders nothing when there is no sendError", () => {
    mocks.projectData = { workspace_id: "ws-1" };
    mocks.workspaceData = { role: "ADMIN" };
    mocks.sendError = null;

    render(<AiAssistantPanel projectId="proj-1" onClose={mocks.onClose} />);

    expect(screen.queryByText(/requires|failed/i)).toBeNull();
  });
});
