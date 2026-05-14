"use client";

import { useLayout } from "@/components/layout/app-layout";

// Portal target for the global AiAssistantPanel. State stays in AppLayout so
// chat survives this host's unmount; the host just registers a slot element.
export function AiPanelSlot() {
  const { setAiPanelSlotEl } = useLayout();
  return <div ref={setAiPanelSlotEl} className="flex shrink-0" />;
}
