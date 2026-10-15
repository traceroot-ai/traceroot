"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageList } from "./message-list";
import type { AIMessage } from "../types";

// Reviewed, shortened snapshot of a completed demo RCA (2026-10-14).
// Never fetch another user's chat or copy private history into the demo.
// Tool outputs omitted by capture policy remain omitted here.
const EXAMPLE: AIMessage[] = [
  {
    id: "demo-question",
    role: "user",
    timestamp: "2026-10-14T15:21:14.925Z",
    content:
      'The "Ungrounded policy answers" detector flagged a claim that supervisor review takes 1–2 business days. Investigate whether the trace supports that claim.',
  },
  {
    id: "demo-download",
    role: "tool_step",
    content: "",
    timestamp: "2026-10-14T15:21:45.507Z",
    toolStep: {
      toolCallId: "demo-download",
      toolName: "download_traces",
      args: {
        label: "Download the trace for analysis",
        traceIds: ["a1278ff61ba8cec1b82d8ca68dd3e573"],
      },
      status: "done",
      result: { content: [{ type: "text", text: "Downloaded 1/1 traces (51 spans)." }] },
    },
  },
  {
    id: "demo-inspect",
    role: "tool_step",
    content: "",
    timestamp: "2026-10-14T15:21:47.912Z",
    toolStep: {
      toolCallId: "demo-inspect",
      toolName: "bash",
      args: { label: "Inspect trace metadata, hierarchy, and errors" },
      status: "done",
      withheld: "not-allowlisted",
    },
  },
  {
    id: "demo-answer",
    role: "assistant",
    timestamp: "2026-10-14T15:22:05.650Z",
    content:
      "### Ungrounded policy answers\n- **Root cause:** This appears to be a false positive: the help-center result explicitly says larger refunds need supervisor review, which takes 1–2 business days.\n- **Code location:** `support_agent.py:480` (orders-agent handler; the trace does not expose a more specific generation location).\n- **Recent changes:** Not checked; repository access was unavailable for this run.\n- **Recommendation:** Update the detector’s grounding check to account for retrieved help-center results before flagging policy claims.",
  },
];

export function DemoAgentExamples({ projectId }: { projectId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 py-3 text-[12px] text-muted-foreground">
        Explore this example investigation. Demo conversations are read-only.
      </div>
      {open ? (
        <>
          <div className="px-4">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Back to examples
            </Button>
          </div>
          <p className="px-4 pt-2 text-[11px] text-muted-foreground">
            Recorded demo investigation · shortened for clarity
          </p>
          <MessageList messages={EXAMPLE} projectId={projectId} />
        </>
      ) : (
        <div className="p-4">
          <h1 className="mb-4 text-[15px] font-medium">Example investigations</h1>
          <Card>
            <CardHeader>
              <CardTitle className="text-[14px]">
                Was this policy answer actually unsupported?
              </CardTitle>
              <CardDescription>
                Follow the agent from a detector finding to the trace evidence and its
                recommendation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                View investigation
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
