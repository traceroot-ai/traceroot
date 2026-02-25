import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Executor } from "../executors/interface.js";

const FASTAPI_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";

const downloadTraceSchema = Type.Object({
  label: Type.String({
    description: "Brief description of what you're downloading (shown to user)",
  }),
  traceId: Type.String({ description: "The trace ID to download" }),
});

type DownloadTraceParams = Static<typeof downloadTraceSchema>;

function sanitizeName(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "") || "unnamed"
  );
}

export function createDownloadTraceTool(
  projectId: string,
  userId: string,
  executor: Executor,
): AgentTool<any> {
  return {
    name: "download_trace",
    label: "Download trace",
    description:
      "Download a full trace into the workspace for deep analysis. Creates 3 files: trace.jsonl (metadata), tree.json (hierarchy), spans.jsonl (all spans, one per line). Use grep/jq on spans.jsonl to analyze.",
    parameters: downloadTraceSchema,
    execute: async (
      _toolCallId: string,
      params: DownloadTraceParams,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<undefined>> => {
      // Ensure sandbox is initialized (lazy init)
      if (!executor.isReady()) {
        await executor.init();
      }

      // Fetch full trace from FastAPI
      // Response: { trace_id, name, spans: SpanResponse[], ... }
      const url = `${FASTAPI_URL}/api/v1/projects/${projectId}/traces/${params.traceId}`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-user-id": userId,
      };

      const res = await fetch(url, { headers, signal });
      if (!res.ok) {
        const text = await res.text();
        return {
          content: [{ type: "text", text: `Error downloading trace: HTTP ${res.status} ${text}` }],
          details: undefined,
        };
      }

      const trace = await res.json();
      const spans = trace.spans || [];
      const traceName = sanitizeName(trace.name || "unnamed");
      const traceDir = `/workspace/traces/${params.traceId}_${traceName}`;

      // 1. Write trace.jsonl — trace metadata as single JSONL line
      const traceMetadata = { ...trace };
      delete traceMetadata.spans;
      await executor.writeFile(`${traceDir}/trace.jsonl`, JSON.stringify(traceMetadata) + "\n");

      // 2. Build and write tree.json — hierarchy structure (pretty-printed)
      const spanLookup = new Map(spans.map((s: any) => [s.span_id, s]));
      const childrenMap = new Map<string | null, string[]>();
      for (const span of spans) {
        const parentId = span.parent_span_id || null;
        if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
        childrenMap.get(parentId)!.push(span.span_id);
      }

      function buildSubtree(spanId: string): Record<string, any> {
        const children = childrenMap.get(spanId) || [];
        const subtree: Record<string, any> = {};
        for (const childId of children) {
          const child = spanLookup.get(childId) as any;
          const key = `${childId}_${sanitizeName(child.name || "unnamed")}`;
          subtree[key] = buildSubtree(childId);
        }
        return subtree;
      }

      const tree: Record<string, any> = {};
      for (const rootId of childrenMap.get(null) || []) {
        const root = spanLookup.get(rootId) as any;
        const key = `${rootId}_${sanitizeName(root.name || "unnamed")}`;
        tree[key] = buildSubtree(rootId);
      }

      await executor.writeFile(`${traceDir}/tree.json`, JSON.stringify(tree, null, 2));

      // 3. Write spans.jsonl — one span per line
      const spanLines = spans.map((s: any) => JSON.stringify(s));
      await executor.writeFile(`${traceDir}/spans.jsonl`, spanLines.join("\n") + "\n");

      const resultText = [
        `Downloaded trace ${params.traceId} to ${traceDir}/`,
        `Files:`,
        `  ${traceDir}/trace.jsonl  — trace metadata`,
        `  ${traceDir}/tree.json    — span hierarchy`,
        `  ${traceDir}/spans.jsonl  — ${spans.length} spans (one per line)`,
        ``,
        `Quick start:`,
        `  cat ${traceDir}/tree.json | jq .           # View hierarchy`,
        `  grep error ${traceDir}/spans.jsonl          # Find errors`,
        `  grep GENERATION ${traceDir}/spans.jsonl     # Find LLM calls`,
      ].join("\n");

      return {
        content: [{ type: "text", text: resultText }],
        details: undefined,
      };
    },
  };
}
