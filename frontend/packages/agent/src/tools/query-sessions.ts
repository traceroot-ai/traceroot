import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const FASTAPI_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";

const querySessionsSchema = Type.Object({
  label: Type.String({
    description: "Brief description of what you're querying (shown to user)",
  }),
  sessionId: Type.Optional(
    Type.String({
      description: "Fetch details for a specific session (returns all traces in it)",
    }),
  ),
  searchQuery: Type.Optional(
    Type.String({ description: "Search sessions by session ID substring" }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Max sessions to return when no sessionId is given (default 20)" }),
  ),
});

type QuerySessionsParams = Static<typeof querySessionsSchema>;

export function createQuerySessionsTool(projectId: string, userId: string): AgentTool<any> {
  return {
    name: "query_sessions",
    label: "Query sessions",
    description:
      "Get session details or list sessions. When called with a sessionId, returns the session overview and all its traces (IDs, names, I/O summaries, status). Use this first to orient before calling download_session.",
    parameters: querySessionsSchema,
    execute: async (
      _toolCallId: string,
      params: QuerySessionsParams,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<undefined>> => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-user-id": userId,
      };

      // Single session detail
      if (params.sessionId) {
        const url = `${FASTAPI_URL}/api/v1/projects/${projectId}/sessions/${params.sessionId}`;
        const res = await fetch(url, { headers, signal });
        if (!res.ok) {
          const text = await res.text();
          return {
            content: [{ type: "text", text: `Error fetching session: HTTP ${res.status} ${text}` }],
            details: undefined,
          };
        }

        const data = await res.json();
        const traces: any[] = data.traces || [];

        if (traces.length === 0) {
          return {
            content: [{ type: "text", text: `Session ${params.sessionId} has no traces.` }],
            details: undefined,
          };
        }

        const durationStr =
          data.duration_ms != null ? `${Math.round(data.duration_ms)}ms` : "unknown";
        const userStr = (data.user_ids || []).join(", ") || "none";

        const traceLines = traces.map((t: any, i: number) => {
          const dur = t.duration_ms != null ? `${Math.round(t.duration_ms)}ms` : "?";
          const inp = t.input ? t.input.slice(0, 200) : "(none)";
          const out = t.output ? t.output.slice(0, 200) : "(none)";
          return [
            `#${i + 1} ${t.trace_id} — ${t.name || "(unnamed)"} | ${t.status} | ${dur}`,
            `   Input:  ${inp}`,
            `   Output: ${out}`,
          ].join("\n");
        });

        const summary = [
          `Session: ${data.session_id}`,
          `Traces: ${data.trace_count} | Duration: ${durationStr} | Users: ${userStr}`,
          ``,
          traceLines.join("\n\n"),
        ].join("\n");

        return {
          content: [{ type: "text", text: summary }],
          details: undefined,
        };
      }

      // List sessions
      const queryParams = new URLSearchParams();
      queryParams.set("limit", String(params.limit || 20));
      if (params.searchQuery) queryParams.set("search_query", params.searchQuery);

      const url = `${FASTAPI_URL}/api/v1/projects/${projectId}/sessions?${queryParams}`;
      const res = await fetch(url, { headers, signal });
      if (!res.ok) {
        const text = await res.text();
        return {
          content: [{ type: "text", text: `Error listing sessions: HTTP ${res.status} ${text}` }],
          details: undefined,
        };
      }

      const data = await res.json();
      const sessions: any[] = data.data || [];

      if (sessions.length === 0) {
        return {
          content: [{ type: "text", text: "No sessions found." }],
          details: undefined,
        };
      }

      const lines = sessions.map((s: any) => {
        const dur = s.duration_ms != null ? `${Math.round(s.duration_ms)}ms` : "?";
        return `- ${s.session_id} | ${s.trace_count} traces | ${dur} | users: ${(s.user_ids || []).join(", ") || "none"}`;
      });

      return {
        content: [
          { type: "text", text: `Found ${sessions.length} sessions:\n${lines.join("\n")}` },
        ],
        details: undefined,
      };
    },
  };
}
