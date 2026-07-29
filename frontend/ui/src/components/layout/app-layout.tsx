"use client";

import { useState, useEffect, useCallback, createContext, useContext, ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { Button } from "@/components/ui/button";
import { PanelLeft } from "lucide-react";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { AiAssistantPanel } from "@/features/ai-assistant/components/ai-assistant-panel";
import { AiChatProvider } from "@/features/ai-assistant/components/ai-chat-context";
import type { AiTraceContext } from "@/features/ai-assistant/types";

interface LayoutContextType {
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  headerContent: ReactNode;
  setHeaderContent: (content: ReactNode) => void;
  aiPanelOpen: boolean;
  setAiPanelOpen: (open: boolean) => void;
  aiContext: AiTraceContext | null;
  setAiContext: (context: AiTraceContext | null) => void;
  // Pre-load an existing chat session (e.g. RCA from the detector findings
  // flow). Set alongside aiContext + aiPanelOpen when opening the panel into
  // an existing session; clear when opening a fresh chat.
  aiInitialSessionId: string | undefined;
  setAiInitialSessionId: (sessionId: string | undefined) => void;
  hideAiButton: boolean;
  setHideAiButton: (hide: boolean) => void;
  // Hosts (TraceViewerPanel / SessionDetailPanel) claim ownership of the AI
  // visual slot on mount so AppLayout's project-wide rail steps aside and the
  // host's own ResizablePanel renders the assistant instead. Returns an
  // unregister callback for the host's effect cleanup.
  viewerOwnsAiSlot: boolean;
  registerAiHost: () => () => void;
}

const LayoutContext = createContext<LayoutContextType>({
  sidebarCollapsed: false,
  setSidebarCollapsed: () => {},
  headerContent: null,
  setHeaderContent: () => {},
  aiPanelOpen: false,
  setAiPanelOpen: () => {},
  aiContext: null,
  setAiContext: () => {},
  aiInitialSessionId: undefined,
  setAiInitialSessionId: () => {},
  hideAiButton: false,
  setHideAiButton: () => {},
  viewerOwnsAiSlot: false,
  registerAiHost: () => () => {},
});

export function useLayout() {
  return useContext(LayoutContext);
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [headerContent, setHeaderContent] = useState<ReactNode>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiContext, setAiContext] = useState<AiTraceContext | null>(null);
  const [aiInitialSessionId, setAiInitialSessionId] = useState<string | undefined>(undefined);
  const [hideAiButton, setHideAiButton] = useState(true);
  const [aiHostRefCount, setAiHostRefCount] = useState(0);
  const pathname = usePathname();

  // Close the global AI panel whenever the user navigates.
  // NOTE: do NOT reset hideAiButton here. Observability pages own that flag.
  useEffect(() => {
    setAiPanelOpen(false);
    setAiContext(null);
    setAiInitialSessionId(undefined);
  }, [pathname]);

  const registerAiHost = useCallback(() => {
    setAiHostRefCount((c) => c + 1);
    return () => setAiHostRefCount((c) => Math.max(0, c - 1));
  }, []);

  const viewerOwnsAiSlot = aiHostRefCount > 0;

  const isObservabilityPage = /^\/projects\/[^/]+\/(traces|users|sessions)(\/|$)/.test(pathname);
  // Viewer panels (trace / session detail) carry their own AI Assistant
  // button, so the navbar copy would duplicate it — visibly so in fullscreen,
  // where the panel sits below the header instead of covering it. Step aside
  // while any viewer owns the AI slot; the button returns when it unmounts.
  const showAiButton = isObservabilityPage && !hideAiButton && !viewerOwnsAiSlot;
  const projectIdMatch = pathname.match(/^\/projects\/([^/]+)/);
  const projectId = projectIdMatch?.[1];

  // Don't show layout on auth pages
  if (pathname.startsWith("/auth/")) {
    return <>{children}</>;
  }

  const showAppRailAi = aiPanelOpen && !viewerOwnsAiSlot;

  return (
    <LayoutContext.Provider
      value={{
        sidebarCollapsed,
        setSidebarCollapsed,
        headerContent,
        setHeaderContent,
        aiPanelOpen,
        setAiPanelOpen,
        aiContext,
        setAiContext,
        aiInitialSessionId,
        setAiInitialSessionId,
        hideAiButton,
        setHideAiButton,
        viewerOwnsAiSlot,
        registerAiHost,
      }}
    >
      <AiChatProvider
        projectId={projectId}
        initialContext={aiContext}
        initialSessionId={aiInitialSessionId}
      >
        <div className="flex h-screen overflow-hidden">
          <Sidebar collapsed={sidebarCollapsed} />

          <ResizablePanelGroup orientation="horizontal" className="min-w-0 flex-1 overflow-hidden">
            <ResizablePanel
              id="main-content"
              minSize="0px"
              className="flex min-w-0 flex-col overflow-hidden"
            >
              {/* Top header bar */}
              <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                >
                  <PanelLeft className="h-4 w-4" />
                </Button>

                {headerContent}

                {showAiButton && (
                  <div className="ml-auto">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => {
                        if (aiPanelOpen) setAiContext(null);
                        setAiInitialSessionId(undefined);
                        setAiPanelOpen(!aiPanelOpen);
                      }}
                      title="AI Assistant"
                    >
                      <DOMAIN_ICONS.assistant className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </header>

              <main className="min-h-0 flex-1 overflow-auto">{children}</main>
            </ResizablePanel>

            {showAppRailAi && (
              <>
                <ResizableHandle />
                <ResizablePanel
                  id="app-ai-panel"
                  defaultSize="400px"
                  minSize="280px"
                  maxSize="520px"
                  groupResizeBehavior="preserve-pixel-size"
                  className="min-w-0 border-border"
                >
                  <AiAssistantPanel
                    projectId={projectId}
                    onClose={() => {
                      setAiPanelOpen(false);
                      setAiContext(null);
                      setAiInitialSessionId(undefined);
                    }}
                  />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </div>
      </AiChatProvider>
    </LayoutContext.Provider>
  );
}
