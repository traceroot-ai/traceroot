"use client";

import { useState, useEffect, useCallback, createContext, useContext, ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { Button } from "@/components/ui/button";
import { Menu, PanelLeft } from "lucide-react";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { isChromelessRoute } from "@/lib/chromeless-routes";
import { cn } from "@/lib/utils";
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

// Between the mobile drawer (md, 768px) and a roomy desktop the full sidebar costs too much width.
const COMPACT_NAV_QUERY = "(max-width: 1099px)";

export function useLayout() {
  return useContext(LayoutContext);
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  // Three navigation stages follow the window: a permanent sidebar, an icon rail below
  // COMPACT_NAV_QUERY, and an off-canvas drawer below md (768px). An explicit toggle by the
  // user wins over the rail until the page is reloaded.
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  const [compactViewport, setCompactViewport] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const sidebarCollapsed = userCollapsed ?? compactViewport;
  const setSidebarCollapsed = useCallback((collapsed: boolean) => setUserCollapsed(collapsed), []);
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
    setMobileNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(COMPACT_NAV_QUERY);
    const sync = () => setCompactViewport(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileNavOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileNavOpen]);

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

  // Some surfaces render on their own, with no shell (sidebar, header, user
  // menu) around them. Which ones — and the reason for each, because they
  // differ — is in lib/chromeless-routes.
  if (isChromelessRoute(pathname)) {
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
        {/* Shell sizes for fullscreen overlays; nav width mirrors Sidebar's w-14 / w-56, 0 below md. */}
        <div
          className={cn(
            "flex h-dvh overflow-hidden [--app-header-h:2.75rem] [--app-nav-w:0px]",
            sidebarCollapsed ? "md:[--app-nav-w:3.5rem]" : "md:[--app-nav-w:14rem]",
          )}
        >
          <div data-testid="desktop-nav" className="hidden md:block">
            <Sidebar collapsed={sidebarCollapsed} />
          </div>
          {mobileNavOpen && (
            <div data-testid="mobile-nav" className="fixed inset-0 z-50 md:hidden">
              <button
                type="button"
                aria-label="Close navigation"
                className="absolute inset-0 bg-foreground/40"
                onClick={() => setMobileNavOpen(false)}
              />
              <div className="animate-slide-in-left absolute inset-y-0 left-0 shadow-[0_4px_12px_rgba(11,16,21,0.08)]">
                <Sidebar collapsed={false} />
              </div>
            </div>
          )}

          <ResizablePanelGroup orientation="horizontal" className="min-w-0 flex-1 overflow-hidden">
            <ResizablePanel
              id="main-content"
              minSize="0px"
              className="flex min-w-0 flex-col overflow-hidden"
            >
              {/* Top header bar */}
              <header className="flex h-[var(--app-header-h)] shrink-0 items-center gap-1 border-b bg-background px-3">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 md:hidden"
                  aria-label="Open navigation"
                  onClick={() => setMobileNavOpen(true)}
                >
                  <Menu className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="mr-1 hidden h-7 w-7 shrink-0 md:inline-flex"
                  aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
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
                      className="h-7 w-7 shrink-0"
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
