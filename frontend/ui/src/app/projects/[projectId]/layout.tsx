"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BotMessageSquare } from "lucide-react";
import { AiAssistantPanel } from "@/features/ai-assistant/components/ai-assistant-panel";

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const projectId = params.projectId as string;
  const [aiPanelOpen, setAiPanelOpen] = useState(false);

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Project header with AI button */}
        <header className="flex h-14 items-center justify-end gap-2 border-b bg-background px-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => setAiPanelOpen(!aiPanelOpen)}
            title="AI Assistant"
          >
            <BotMessageSquare className="h-4 w-4" />
          </Button>
        </header>
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
      <AiAssistantPanel open={aiPanelOpen} onClose={() => setAiPanelOpen(false)} />
    </div>
  );
}
