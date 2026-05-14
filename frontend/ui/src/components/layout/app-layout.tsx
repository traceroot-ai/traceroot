"use client";

import { useState, useEffect, createContext, useContext, ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { Button } from "@/components/ui/button";
import { PanelLeft, BotMessageSquare } from "lucide-react";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { AiAssistantPanel } from "@/features/ai-assistant/components/ai-assistant-panel";
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
  hideAiButton: boolean;
  setHideAiButton: (hide: boolean) => void;
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
  hideAiButton: false,
  setHideAiButton: () => {},
});

export function useLayout() {
  return useContext(LayoutContext);
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [headerContent, setHeaderContent] = useState<ReactNode>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiContext, setAiContext] = useState<AiTraceContext | null>(null);
  const [hideAiButton, setHideAiButton] = useState(true);
  const pathname = usePathname();

  // Close the global AI panel whenever the user navigates.
  // NOTE: do NOT reset hideAiButton here. TracesPage.useLayoutEffect is the sole
  // owner of that flag. Resetting it here creates a race: useLayoutEffect (child,
  // synchronous) fires before useEffect (parent, async), so this reset always
  // overwrites the correct value set by TracesPage — hiding the button in prod
  // (Strict Mode's double-invoke masked the bug locally). The isTracesPage guard
  // in showAiButton already prevents the button from rendering on other pages.
  useEffect(() => {
    setAiPanelOpen(false);
    setAiContext(null);
  }, [pathname]);

  const isObservabilityPage = /^\/projects\/[^/]+\/(traces|users|sessions)(\/|$)/.test(pathname);
  const showAiButton = isObservabilityPage && !hideAiButton;
  const projectIdMatch = pathname.match(/^\/projects\/([^/]+)/);
  const projectId = projectIdMatch?.[1];

  // Don't show layout on auth pages
  if (pathname.startsWith("/auth/")) {
    return <>{children}</>;
  }

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
        hideAiButton,
        setHideAiButton,
      }}
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
                      setAiPanelOpen(!aiPanelOpen);
                    }}
                    title="AI Assistant"
                  >
                    <BotMessageSquare className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </header>

            <main className="min-h-0 flex-1 overflow-auto">{children}</main>
          </ResizablePanel>

          {aiPanelOpen && (
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
                  initialContext={aiContext}
                  onClose={() => {
                    setAiPanelOpen(false);
                    setAiContext(null);
                  }}
                />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    </LayoutContext.Provider>
  );
}
