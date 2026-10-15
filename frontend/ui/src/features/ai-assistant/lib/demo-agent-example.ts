import type { AIMessage, AISession } from "../types";

// Reviewed, shortened snapshot of a completed demo RCA (2026-10-14).
// Never fetch another user's chat or copy private history into the demo.
// Tool outputs omitted by capture policy remain omitted here.
export const DEMO_EXAMPLE_MESSAGES: AIMessage[] = [
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

export const DEMO_EXAMPLE_SESSION: Omit<AISession, "projectId"> = {
  id: "demo-example-policy",
  title: "Was this policy answer actually unsupported?",
  status: "completed",
  createTime: "2026-10-14T15:21:14.925Z",
  isExample: true,
};
