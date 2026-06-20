"use client";

import { SessionDetailPanel } from "@/features/traces/components/SessionDetailPanel";
import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function TestPanelContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isFullscreen = searchParams.get("fullscreen") === "1";
  const [selectedSession, setSelectedSession] = useState<string | null>(null);

  return (
    <div className="relative flex h-screen w-full overflow-hidden bg-neutral-900 text-white">
      {/* Mock Main Content Area */}
      <div className="flex-1 p-8">
        <h1 className="mb-8 text-2xl font-bold">Traceroot Mock Sessions</h1>
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              onClick={() => setSelectedSession(`session-${i}`)}
              className="cursor-pointer rounded border border-neutral-700 bg-neutral-800 p-4 transition hover:bg-neutral-700"
            >
              Session Row {i} - Click me to open panel
            </div>
          ))}
        </div>
      </div>

      {/* Mock Slide-in Panel */}
      {selectedSession && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm transition-opacity"
            onClick={() => setSelectedSession(null)}
          />
          <SessionDetailPanel
            projectId="mock-project"
            sessionId={selectedSession}
            onClose={() => setSelectedSession(null)}
            onNavigate={() => {}}
            canNavigateUp={false}
            canNavigateDown={false}
            initialFullscreen={isFullscreen}
          />
        </>
      )}
    </div>
  );
}

export default function TestPanelPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <TestPanelContent />
    </Suspense>
  );
}
