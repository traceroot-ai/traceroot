// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const releaseAiHost = vi.fn();
  const registerAiHost = vi.fn(() => releaseAiHost);
  return {
    registerAiHost,
    releaseAiHost,
    setAiContext: vi.fn(),
    aiContext: null as { traceId?: string } | null,
    aiInitialSessionId: undefined as string | undefined,
    handleSend: vi.fn(),
    messages: [] as Array<{ id: string; role: string; content: string }>,
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
  };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
}));

vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    registerAiHost: mocks.registerAiHost,
    aiContext: mocks.aiContext,
    setAiContext: mocks.setAiContext,
    aiInitialSessionId: mocks.aiInitialSessionId,
  }),
}));

vi.mock("@/features/projects/components", () => ({
  ProjectBreadcrumb: ({ projectId }: { projectId: string }) => (
    <div data-testid="breadcrumb" data-project-id={projectId} />
  ),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === "project") return { data: mocks.projectData };
    if (queryKey[0] === "llm-models") return { data: mocks.llmModels };
    return { data: undefined };
  },
}));

vi.mock("@/lib/api", () => ({
  getProject: vi.fn(),
  getAvailableLLMModels: vi.fn(),
}));

vi.mock("@/features/ai-assistant/components/ai-chat-context", () => ({
  useAiChatContext: () => ({
    messages: mocks.messages,
    isStreaming: false,
    sessions: [],
    historyOpen: false,
    currentSessionId: null,
    setHistoryOpen: vi.fn(),
    handleSend: mocks.handleSend,
    handleAbort: vi.fn(),
    handleNewSession: vi.fn(),
    handleClose: vi.fn(),
    handleOpenHistory: vi.fn(),
    handleSelectSession: vi.fn(),
    handleDeleteSession: vi.fn(),
  }),
}));

// Heavy chat children are covered by their own tests
vi.mock("@/features/ai-assistant/components/message-list", () => ({
  MessageList: () => null,
}));
vi.mock("@/features/ai-assistant/components/message-input", () => ({
  MessageInput: () => null,
}));
vi.mock("@/features/ai-assistant/components/session-history", () => ({
  SessionHistory: () => null,
}));

import HomePage from "./page";

afterEach(() => {
  cleanup();
  mocks.registerAiHost.mockClear();
  mocks.releaseAiHost.mockClear();
  mocks.setAiContext.mockClear();
  mocks.handleSend.mockClear();
  mocks.aiContext = null;
  mocks.aiInitialSessionId = undefined;
  mocks.messages = [];
  mocks.projectData = undefined;
  mocks.llmModels = undefined;
});

describe("Home page", () => {
  it("renders the assistant in page variant: New and History present, Close absent", () => {
    render(<HomePage />);
    expect(screen.getByTitle("New session")).not.toBeNull();
    expect(screen.getByTitle("History")).not.toBeNull();
    // The Close button is the only header control rendering an X icon.
    expect(document.querySelector("svg.lucide-x")).toBeNull();
  });

  it("renders the project breadcrumb for the route's project", () => {
    render(<HomePage />);
    expect(screen.getByTestId("breadcrumb").getAttribute("data-project-id")).toBe("proj-1");
  });

  it("claims the AI slot on mount and releases it on unmount", () => {
    const { unmount } = render(<HomePage />);
    expect(mocks.registerAiHost).toHaveBeenCalledTimes(1);
    expect(mocks.releaseAiHost).not.toHaveBeenCalled();
    unmount();
    expect(mocks.releaseAiHost).toHaveBeenCalledTimes(1);
  });

  it("centers the assistant in a max-width column", () => {
    const { container } = render(<HomePage />);
    const column = container.querySelector('[class*="max-w-[900px]"]');
    expect(column).not.toBeNull();
    expect(column!.className).toContain("mx-auto");
  });

  it("renders the greeting inside the panel, centered after the toolbar", () => {
    render(<HomePage />);
    const toolbarButton = screen.getByTitle("New session");
    const heading = screen.getByText("How can I help?");
    // The greeting follows the toolbar in DOM order (it lives in the message
    // region, not above the panel) and sits in the margin-auto-centered child
    // of the scrollable region, so short viewports scroll instead of clipping.
    expect(
      toolbarButton.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const centered = heading.closest('[class*="m-auto"]');
    expect(centered).not.toBeNull();
    const scrollRegion = centered!.parentElement!;
    expect(scrollRegion.className).toContain("flex-1");
    expect(scrollRegion.className).toContain("overflow-y-auto");
  });

  it("suppresses the greeting during a session handoff", () => {
    mocks.aiInitialSessionId = "sess-9";
    render(<HomePage />);
    expect(screen.queryByText("How can I help?")).toBeNull();
  });

  it("sends a starter prompt through the chat send path with the default model", () => {
    mocks.projectData = { workspace_id: "ws-1" };
    mocks.llmModels = {
      systemModels: [
        {
          provider: "anthropic",
          adapter: "anthropic",
          source: "system",
          models: [{ id: "model-a", label: "Model A" }],
        },
      ],
      byokProviders: [],
    };
    render(<HomePage />);

    fireEvent.click(screen.getByRole("button", { name: "Summarize today's sessions" }));
    expect(mocks.handleSend).toHaveBeenCalledWith("Summarize today's sessions", {
      model: "model-a",
      provider: "anthropic",
      source: "system",
      adapter: "anthropic",
    });
  });

  it("disables starter prompts until the model list has loaded", () => {
    render(<HomePage />);
    const chip = screen.getByRole("button", {
      name: "Summarize today's sessions",
    }) as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    fireEvent.click(chip);
    expect(mocks.handleSend).not.toHaveBeenCalled();
  });

  it("hides the starter prompts once the conversation has messages", () => {
    mocks.messages = [{ id: "m1", role: "user", content: "hi" }];
    render(<HomePage />);
    expect(screen.queryByRole("button", { name: "Summarize today's sessions" })).toBeNull();
  });

  it("clears a stale trace context on mount", () => {
    mocks.aiContext = { traceId: "trace-1" };
    render(<HomePage />);
    expect(mocks.setAiContext).toHaveBeenCalledWith(null);
  });

  it("preserves the context while a session handoff is in flight", () => {
    mocks.aiContext = { traceId: "trace-1" };
    mocks.aiInitialSessionId = "sess-9";
    render(<HomePage />);
    expect(mocks.setAiContext).not.toHaveBeenCalled();
  });

  it("leaves the context alone when there is nothing to clear", () => {
    render(<HomePage />);
    expect(mocks.setAiContext).not.toHaveBeenCalled();
  });
});
