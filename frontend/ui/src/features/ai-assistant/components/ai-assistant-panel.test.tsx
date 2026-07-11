// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

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
  members: undefined as Array<{ user_id: string; role: string }> | undefined,
  userId: undefined as string | undefined,
  sessionHistoryCanDelete: undefined as boolean | undefined,
  onClose: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "project") return { data: mocks.projectData };
    if (queryKey[0] === "llm-models") return { data: mocks.llmModels };
    if (queryKey[0] === "workspace-members") return { data: mocks.members };
    return { data: undefined };
  },
}));

vi.mock("@/lib/api", () => ({
  getProject: vi.fn(),
  getAvailableLLMModels: vi.fn(),
  getMembers: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: mocks.userId ? { user: { id: mocks.userId } } : undefined }),
}));

vi.mock("./ai-chat-context", () => ({
  useAiChatContext: () => ({
    messages: [],
    isStreaming: false,
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
  mocks.members = undefined;
  mocks.userId = undefined;
  mocks.sessionHistoryCanDelete = undefined;
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
    mocks.members = [{ user_id: "user-admin", role: "ADMIN" }];
    mocks.userId = "user-admin";

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
    mocks.members = [{ user_id: "user-member", role: "MEMBER" }];
    mocks.userId = "user-member";

    render(<AiAssistantPanel projectId="proj-1" onClose={mocks.onClose} />);

    expect(mocks.sessionHistoryCanDelete).toBe(false);
  });
});
