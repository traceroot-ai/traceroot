import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const FASTAPI_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";

const queryTracesSchema = Type.Object({
  label: Type.String({
    description: "Brief description of what you're searching for (shown to user)",
  }),
  limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
  userId: Type.Optional(Type.String({ description: "Filter by user ID" })),
  name: Type.Optional(Type.String({ description: "Filter by trace name (partial match)" })),
  searchQuery: Type.Optional(
    Type.String({ description: "Search across trace_id, name, session_id, user_id" }),
  ),
  startAfter: Type.Optional(
    Type.String({ description: "Filter traces after this time (ISO 8601)" }),
  ),
  endBefore: Type.Optional(
    Type.String({ description: "Filter traces before this time (ISO 8601)" }),
  ),
});

type QueryTracesParams = Static<typeof queryTracesSchema>;

export function createQueryTracesTool(projectId: string, userId: string): AgentTool<any> {
  return {
    name: "query_traces",
    label: "Query traces",
    description:
      "Search and filter traces for the current project. Returns a summary table of matching traces (IDs, names, timestamps, status, error counts). Use this for discovery before downloading specific traces.",
    parameters: queryTracesSchema,
    execute: async (
      _toolCallId: string,
      params: QueryTracesParams,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<undefined>> => {
      const queryParams = new URLSearchParams();
      queryParams.set("limit", String(params.limit || 20));
      if (params.userId) queryParams.set("user_id", params.userId);
      if (params.name) queryParams.set("name", params.name);
      if (params.searchQuery) queryParams.set("search_query", params.searchQuery);
      if (params.startAfter) queryParams.set("start_after", params.startAfter);
      if (params.endBefore) queryParams.set("end_before", params.endBefore);

      const url = `${FASTAPI_URL}/api/v1/projects/${projectId}/traces?${queryParams}`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-user-id": userId,
        "X-Internal-Secret": process.env.INTERNAL_API_SECRET || "",
      };

      const res = await fetch(url, { headers, signal });
      if (!res.ok) {
        const text = await res.text();
        return {
          content: [{ type: "text", text: `Error querying traces: HTTP ${res.status} ${text}` }],
          details: undefined,
        };
      }

      const data = await res.json();
      // FastAPI returns { data: TraceListItem[], meta: { page, limit, total } }
      const traces = data.data || [];
      const meta = data.meta || {};

      if (!Array.isArray(traces) || traces.length === 0) {
        return {
          content: [{ type: "text", text: "No traces found matching the given filters." }],
          details: undefined,
        };
      }

      // Format as summary table for the agent
      const lines = traces.map((t: any) => {
        const duration = t.duration_ms != null ? `${Math.round(t.duration_ms)}ms` : "?";
        return `- ${t.trace_id} | ${t.name || "(unnamed)"} | ${t.trace_start_time} | ${t.status} | ${t.span_count} spans | ${duration}`;
      });

      const totalInfo = meta.total ? ` (${meta.total} total, showing ${traces.length})` : "";

      return {
        content: [
          { type: "text", text: `Found ${traces.length} traces${totalInfo}:\n${lines.join("\n")}` },
        ],
        details: undefined,
      };
    },
  };
}
