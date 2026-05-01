import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Executor } from "../executors/interface.js";
import { downloadOneTrace } from "./download-traces.js";

const FASTAPI_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";

const downloadSessionSchema = Type.Object({
  label: Type.String({
    description: "Brief description of what you're downloading (shown to user)",
  }),
  sessionId: Type.String({ description: "The session ID to download all traces for" }),
});

type DownloadSessionParams = Static<typeof downloadSessionSchema>;

export function createDownloadSessionTool(
  projectId: string,
  userId: string,
  executor: Executor,
): AgentTool<any> {
  return {
    name: "download_session",
    label: "Download session",
    description:
      "Download all traces in a session to the workspace for deep analysis. Fetches all traces in parallel. Writes session.json (overview) and one directory per trace under /workspace/sessions/{sessionId}/traces/. Use query_sessions first to see what's in the session before committing to a full download.",
    parameters: downloadSessionSchema,
    execute: async (
      _toolCallId: string,
      params: DownloadSessionParams,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<undefined>> => {
      if (!executor.isReady()) {
        await executor.init();
      }

      // Step 1: Fetch session details to get all trace IDs
      const sessionUrl = `${FASTAPI_URL}/api/v1/projects/${projectId}/sessions/${params.sessionId}`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-user-id": userId,
        "X-Internal-Secret": process.env.INTERNAL_API_SECRET || "",
      };

      const sessionRes = await fetch(sessionUrl, { headers, signal });
      if (!sessionRes.ok) {
        const text = await sessionRes.text();
        return {
          content: [
            { type: "text", text: `Error fetching session: HTTP ${sessionRes.status} ${text}` },
          ],
          details: undefined,
        };
      }

      const sessionData = await sessionRes.json();
      const traces: any[] = sessionData.traces || [];

      if (traces.length === 0) {
        return {
          content: [{ type: "text", text: `Session ${params.sessionId} has no traces.` }],
          details: undefined,
        };
      }

      const sessionDir = `/workspace/sessions/${params.sessionId}`;
      const tracesDir = `${sessionDir}/traces`;

      // Step 2: Write session.json overview
      await executor.writeFile(`${sessionDir}/session.json`, JSON.stringify(sessionData, null, 2));

      // Step 3: Download all traces in parallel to session-scoped path
      const results = await Promise.allSettled(
        traces.map((t: any) =>
          downloadOneTrace(t.trace_id, tracesDir, projectId, userId, executor, signal),
        ),
      );

      const lines: string[] = [];
      for (let i = 0; i < traces.length; i++) {
        const r = results[i];
        const traceId = traces[i].trace_id;
        if (r.status === "fulfilled") {
          const { dir, spanCount } = r.value;
          lines.push(`✓ ${traceId} → ${dir}/ (${spanCount} spans)`);
        } else {
          lines.push(`✗ ${traceId} — Error: ${r.reason?.message}`);
        }
      }

      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const summary = [
        `Downloaded session ${params.sessionId}: ${succeeded}/${traces.length} traces`,
        ``,
        `Files:`,
        `  ${sessionDir}/session.json        ← session overview`,
        `  ${sessionDir}/traces/             ← one dir per trace`,
        ``,
        lines.join("\n"),
        ``,
        `Quick start:`,
        `  cat ${sessionDir}/session.json | jq '.traces[] | {id:.trace_id, name:.name, status:.status}'`,
        `  ls ${sessionDir}/traces/`,
      ].join("\n");

      return {
        content: [{ type: "text", text: summary }],
        details: undefined,
      };
    },
  };
}
