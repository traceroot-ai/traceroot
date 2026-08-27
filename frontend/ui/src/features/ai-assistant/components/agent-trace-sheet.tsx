"use client";

import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { TraceViewerPanel } from "@/features/traces/components/TraceViewerPanel";
import { LayoutContext, useLayout } from "@/components/layout/app-layout";

/**
 * Hosts the trace viewer for an agent (RCA/follow-up/chat) trace inside the
 * assistant panel, so the Traces section itself is untouched.
 *
 * There is no dedicated "sheet" primitive in this repo (no shadcn Sheet) —
 * `@/components/ui/drawer` is the existing right-anchored slide-in panel
 * (built on the same `@radix-ui/react-dialog` primitive a shadcn Sheet would
 * use) and is used here instead.
 *
 * `TraceViewerPanel` normally calls `registerAiHost()` on mount to claim the
 * app's single AI-assistant slot (so a full-page trace viewer's own "Ask AI"
 * button can swap the assistant into its own layout). That is wrong here:
 * this viewer is rendered *inside* the assistant panel, not beside it — if it
 * claimed the AI slot, `AppLayout` would immediately hide (in rail placement)
 * or duplicate (in viewer-hosted placement) the very panel this sheet lives
 * in. Shadowing `LayoutContext` with a no-op `registerAiHost` and
 * `aiPanelOpen: false` neutralizes both: the nested viewer never claims the
 * slot, and never mounts its own nested `AiAssistantPanel`.
 */
export function AgentTraceSheet({
  projectId,
  traceId,
  onClose,
}: {
  projectId: string;
  traceId: string | null;
  onClose: () => void;
}) {
  const layout = useLayout();

  return (
    <Drawer
      open={!!traceId}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DrawerContent width="w-[min(90vw,1100px)]" className="p-0">
        <DrawerTitle className="sr-only">Trace</DrawerTitle>
        {traceId && (
          <LayoutContext.Provider
            value={{ ...layout, registerAiHost: () => () => {}, aiPanelOpen: false }}
          >
            <TraceViewerPanel
              projectId={projectId}
              traceId={traceId}
              source="agent"
              onClose={onClose}
              onNavigate={() => {}}
              canNavigateUp={false}
              canNavigateDown={false}
            />
          </LayoutContext.Provider>
        )}
      </DrawerContent>
    </Drawer>
  );
}
