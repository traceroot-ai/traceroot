"use client";

import Agent from "@/components/right-panel/agent/Agent";

export default function AgentPage() {
  return (
    <div className="w-full h-screen flex items-center justify-center bg-white dark:bg-black">
      <div className="w-[70%] h-full py-8">
        <Agent useUserBasedHistory={true} />
      </div>
    </div>
  );
}
