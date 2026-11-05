// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AIMessage } from "@/features/ai-assistant/types";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/proj-1/signals",
}));
vi.mock("@/components/layout/sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/lib/hooks/use-retention", () => ({
  useRetention: () => ({ retentionDays: null }),
}));
vi.mock("@/lib/api", () => ({
  getProject: async () => ({ workspace_id: "ws-1" }),
  getAvailableLLMModels: async () => ({
    systemModels: [{ models: [{ id: "test-model" }] }],
    byokProviders: [],
  }),
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));
vi.mock("@/features/dashboards/components/renderers", () => ({
  QueryWidgetRenderer: () => null,
}));
vi.mock("./run-rca", () => ({ RunRca: () => null }));
vi.mock("./signal-status-control", () => ({ SignalStatusControl: () => null }));
vi.mock("@/features/ai-assistant/components/message-list", () => ({
  MessageList: ({ messages }: { messages: AIMessage[] }) => (
    <div data-testid="agent-transcript">
      {messages.map((message) => (
        <p key={message.id}>{message.content}</p>
      ))}
    </div>
  ),
}));
vi.mock("@/features/ai-assistant/components/message-input", () => ({
  MessageInput: () => null,
}));
vi.mock("@/features/ai-assistant/components/agent-trace-sheet", () => ({
  AgentTraceSheet: () => null,
}));
vi.mock("../hooks", () => ({
  useSignal: () => ({
    isPending: false,
    error: null,
    data: {
      merged: false,
      grouping: true,
      signal: {
        id: "sig-1",
        detectorId: "det-1",
        detectorName: "Failure Detector",
        title: "Missing conversion rate",
        status: "open",
        criteriaCovers: "A missing rate crashes currency conversion.",
        criteriaExcludes: "",
        rca: { currentState: "completed" },
        canonicalRca: {
          sessionId: "rca-session-1",
          traceId: "trace-1",
          result: "Guard the missing rate lookup.",
        },
      },
      hits: [],
      hitSeries: [],
      window: { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" },
    },
  }),
  useSignalTraces: () => ({ data: new Map(), isPending: false }),
}));

// Keep the real layout, chat provider, chat hook, stream store and assistant
// close handler: the provider stays mounted while the sidebar closes.
import { AppLayout } from "@/components/layout/app-layout";
import { SignalDetailPanel } from "./signal-detail-panel";

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Signal RCA agent sidebar", () => {
  it.each(["close button", "AI Assistant toggle"])(
    "shows the same session after closing with %s and reopening",
    async (closeWith) => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.endsWith("/ai/sessions/rca-session-1/messages")) {
          throw new Error(`Unexpected fetch: ${url}`);
        }
        return Response.json({
          messages: [
            {
              id: "analysis-1",
              role: "assistant",
              content: "The rate lookup raised KeyError and terminated the run.",
              createTime: "2026-10-01T12:00:00Z",
            },
          ],
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <AppLayout>
            <SignalDetailPanel
              projectId="proj-1"
              signalId="sig-1"
              onClose={vi.fn()}
              onNavigate={vi.fn()}
              canNavigateUp={false}
              canNavigateDown={false}
              onOpenTrace={vi.fn()}
              range={{}}
              rangePicker={null}
              tracesHref="/projects/proj-1/traces"
              fullscreen={false}
              onToggleFullscreen={vi.fn()}
            />
          </AppLayout>
        </QueryClientProvider>,
      );
      const open = screen.getByRole("button", { name: "Open in agent" });
      const transcript = "The rate lookup raised KeyError and terminated the run.";
      fireEvent.click(open);
      await waitFor(() =>
        expect(screen.getByTestId("agent-transcript").textContent).toBe(transcript),
      );

      if (closeWith === "close button") {
        const sidebar = screen.getByTestId("agent-transcript").closest(".border-l")!;
        fireEvent.click(within(sidebar as HTMLElement).getByRole("button", { name: "" }));
      } else {
        fireEvent.click(screen.getByRole("button", { name: "AI Assistant" }));
      }
      expect(screen.queryByTestId("agent-transcript")).toBeNull();

      fireEvent.click(open);
      await waitFor(() =>
        expect(screen.getByTestId("agent-transcript").textContent).toBe(transcript),
      );
    },
  );
});
