"use client";

import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { TraceViewerPanel } from "@/features/traces/components/TraceViewerPanel";

/**
 * Hosts the trace viewer for an agent (RCA/follow-up/chat) trace inside the
 * assistant panel, so the Traces section itself is untouched.
 *
 * There is no dedicated "sheet" primitive in this repo (no shadcn Sheet) —
 * `@/components/ui/drawer` is the existing right-anchored slide-in panel
 * (built on the same `@radix-ui/react-dialog` primitive a shadcn Sheet would
 * use) and is used here instead.
 *
 * The viewer is rendered *inside* the assistant panel, not beside it, so it
 * must not claim the app's single AI-assistant slot (`AppLayout` would hide
 * or duplicate the very panel this sheet lives in) nor mount a nested
 * assistant of its own. `embedded` is what tells `TraceViewerPanel` that.
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
  return (
    <Drawer
      open={!!traceId}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DrawerContent width="w-[min(90vw,1100px)]" className="p-0">
        <DrawerTitle className="sr-only">Trace</DrawerTitle>
        <DrawerDescription className="sr-only">
          The trace recorded for this assistant turn.
        </DrawerDescription>
        {traceId && (
          <TraceViewerPanel
            projectId={projectId}
            traceId={traceId}
            source="agent"
            embedded
            onClose={onClose}
            onNavigate={() => {}}
            canNavigateUp={false}
            canNavigateDown={false}
          />
        )}
      </DrawerContent>
    </Drawer>
  );
}
