"use client";

import { useState } from "react";
import { useParams, usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BotMessageSquare } from "lucide-react";
import { AiAssistantPanel } from "@/features/ai-assistant/components/ai-assistant-panel";

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const pathname = usePathname();
  const projectId = params.projectId as string;
  const [aiPanelOpen, setAiPanelOpen] = useState(false);

  // Hide AI button on settings pages
  const showAiButton = !pathname.includes("/settings");

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Project header with AI button */}
        <header className="flex h-14 items-center justify-end gap-2 border-b bg-background px-3">
          {showAiButton && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setAiPanelOpen(!aiPanelOpen)}
              title="AI Assistant"
            >
              <BotMessageSquare className="h-4 w-4" />
            </Button>
          )}
        </header>
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
      {showAiButton && (
        <AiAssistantPanel open={aiPanelOpen} onClose={() => setAiPanelOpen(false)} />
      )}
    </div>
  );
}
