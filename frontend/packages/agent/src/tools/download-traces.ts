import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Executor } from "../executors/interface.js";

const FASTAPI_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";

const downloadTracesSchema = Type.Object({
  label: Type.String({
    description: "Brief description of what you're downloading (shown to user)",
  }),
  traceIds: Type.Array(Type.String(), {
    description: "One or more trace IDs to download. All are fetched in parallel.",
  }),
});

type DownloadTracesParams = Static<typeof downloadTracesSchema>;

function sanitizeName(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "") || "unnamed"
  );
}

/**
 * Core helper: fetch one trace from FastAPI and write its 3 files into targetDir.
 * Used by both download_traces (writes to /workspace/traces/) and
 * download_session (writes to /workspace/sessions/{id}/traces/).
 */
export async function downloadOneTrace(
  traceId: string,
  targetDir: string,
  projectId: string,
  userId: string,
  executor: Executor,
  signal?: AbortSignal,
): Promise<{ dir: string; spanCount: number; traceName: string }> {
  const url = `${FASTAPI_URL}/api/v1/projects/${projectId}/traces/${traceId}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", "x-user-id": userId },
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${text}`);
  }

  const trace = await res.json();
  const spans = trace.spans || [];
  const traceName = sanitizeName(trace.name || "unnamed");
  const traceDir = `${targetDir}/${traceId}_${traceName}`;

  // trace.jsonl — metadata only (no spans)
  const traceMetadata = { ...trace };
  delete traceMetadata.spans;
  await executor.writeFile(`${traceDir}/trace.jsonl`, JSON.stringify(traceMetadata) + "\n");

  // tree.json — span hierarchy
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

  // spans.jsonl — one span per line
  const spanLines = spans.map((s: any) => JSON.stringify(s));
  await executor.writeFile(`${traceDir}/spans.jsonl`, spanLines.join("\n") + "\n");

  return { dir: traceDir, spanCount: spans.length, traceName };
}

export function createDownloadTracesTool(
  projectId: string,
  userId: string,
  executor: Executor,
): AgentTool<any> {
  return {
    name: "download_traces",
    label: "Download traces",
    description:
      "Download one or more full traces into the workspace for deep analysis. All traces are fetched in parallel. Each trace gets 3 files: trace.jsonl (metadata), tree.json (hierarchy), spans.jsonl (all spans, one per line). Pass a single-element array to download one trace.",
    parameters: downloadTracesSchema,
    execute: async (
      _toolCallId: string,
      params: DownloadTracesParams,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<undefined>> => {
      if (!executor.isReady()) {
        await executor.init();
      }

      const results = await Promise.allSettled(
        params.traceIds.map((traceId) =>
          downloadOneTrace(traceId, "/workspace/traces", projectId, userId, executor, signal),
        ),
      );

      const lines: string[] = [];
      for (let i = 0; i < params.traceIds.length; i++) {
        const r = results[i];
        const traceId = params.traceIds[i];
        if (r.status === "fulfilled") {
          const { dir, spanCount } = r.value;
          lines.push(`✓ ${traceId} → ${dir}/ (${spanCount} spans)`);
          lines.push(`    cat ${dir}/tree.json | jq .`);
          lines.push(`    grep GENERATION ${dir}/spans.jsonl`);
        } else {
          lines.push(`✗ ${traceId} — Error: ${r.reason?.message}`);
        }
      }

      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const summary = `Downloaded ${succeeded}/${params.traceIds.length} traces:\n${lines.join("\n")}`;

      return {
        content: [{ type: "text", text: summary }],
        details: undefined,
      };
    },
  };
}
