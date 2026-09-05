// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

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
  messages: [] as Array<{ id: string; role: string; content: string }>,
  isStreaming: false,
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
    messages: mocks.messages,
    isStreaming: mocks.isStreaming,
    sessions: [],
    historyOpen: false,
    currentSessionId: null,
    modelSelection: { model: "", provider: "", source: "system", adapter: "" },
    setHistoryOpen: vi.fn(),
    setModelSelection: vi.fn(),
    handleSend: vi.fn(),
    handleAbort: vi.fn(),
    handleNewSession: vi.fn(),
    handleClose: vi.fn(),
    handleOpenHistory: vi.fn(),
    handleSelectSession: vi.fn(),
    handleDeleteSession: vi.fn(),
  }),
}));

// The list's "Open span" is the only caller that passes a span id; the stub
// exposes that call so the test can drive it without rendering a tool step.
vi.mock("./message-list", () => ({
  MessageList: (props: { onOpenTrace?: (traceId: string, spanId?: string) => void }) => (
    <button
      type="button"
      data-testid="open-span"
      onClick={() => props.onOpenTrace?.("trace-1", "span-t1")}
    />
  ),
}));
vi.mock("./message-input", () => ({ MessageInput: () => null }));
vi.mock("./session-history", () => ({ SessionHistory: () => null }));
vi.mock("./agent-trace-sheet", () => ({
  AgentTraceSheet: (props: { traceId: string | null; spanId?: string }) => (
    <div
      data-testid="trace-sheet"
      data-trace-id={props.traceId ?? ""}
      data-span-id={props.spanId ?? ""}
    />
  ),
}));

import { AiAssistantPanel } from "./ai-assistant-panel";

afterEach(() => {
  cleanup();
  mocks.projectData = undefined;
  mocks.llmModels = undefined;
  mocks.messages = [];
  mocks.isStreaming = false;
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

  it("renders the Close button in the default rail variant", () => {
    const { container } = render(<AiAssistantPanel projectId="proj-1" onClose={mocks.onClose} />);

    // The Close button is the only header control rendering an X icon.
    const closeButton = container.querySelector("svg.lucide-x")?.closest("button");
    expect(closeButton).not.toBeNull();
    fireEvent.click(closeButton!);
    expect(mocks.onClose).toHaveBeenCalledTimes(1);
  });

  it("hides the emptyState once the conversation has messages", () => {
    mocks.messages = [{ id: "m1", role: "user", content: "hi" }];

    render(
      <AiAssistantPanel
        projectId="proj-1"
        onClose={mocks.onClose}
        emptyState={<div>greeting</div>}
      />,
    );

    expect(screen.queryByText("greeting")).toBeNull();
  });

  it("hides the emptyState while a send is in flight so the waiting UI shows", () => {
    mocks.isStreaming = true;

    render(
      <AiAssistantPanel
        projectId="proj-1"
        onClose={mocks.onClose}
        emptyState={<div>greeting</div>}
      />,
    );

    expect(screen.queryByText("greeting")).toBeNull();
  });

  it("lets the no-models gate win over the emptyState", () => {
    mocks.projectData = { workspace_id: "ws-abc" };
    mocks.llmModels = { systemModels: [], byokProviders: [] };

    render(
      <AiAssistantPanel
        projectId="proj-1"
        onClose={mocks.onClose}
        emptyState={<div>greeting</div>}
      />,
    );

    expect(screen.getByText("No LLM models available")).not.toBeNull();
    expect(screen.queryByText("greeting")).toBeNull();
  });

  it("opens the sheet on the step's trace and span when a tool step's 'Open span' is clicked", () => {
    mocks.messages = [{ id: "m1", role: "user", content: "hi" }];

    render(<AiAssistantPanel projectId="proj-1" onClose={mocks.onClose} />);

    const sheet = screen.getByTestId("trace-sheet");
    expect(sheet.getAttribute("data-trace-id")).toBe("");
    fireEvent.click(screen.getByTestId("open-span"));
    expect(sheet.getAttribute("data-trace-id")).toBe("trace-1");
    expect(sheet.getAttribute("data-span-id")).toBe("span-t1");
  });
});
