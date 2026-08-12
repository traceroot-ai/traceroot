import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  ApiClient,
  INTERNAL_BINDINGS,
  REGISTRY,
  internalAuth,
  toPiAgentTool,
} from "@traceroot-ai/tools";
import { formatSessionDetail, formatSessionList, formatTraceList } from "./formatters.js";

function requireEntry(name: string) {
  const entry = REGISTRY.find((e) => e.name === name);
  if (entry === undefined) {
    throw new Error(`registry entry missing: ${name}`);
  }
  return entry;
}

/**
 * The agent's read tools, generated from the shared registry and bound to the
 * internal project-scoped routes with service auth. Presentation (the text the
 * model sees) stays here — it's surface-local by design.
 */
export function createRegistryReadTools(projectId: string, userId: string): AgentTool<any>[] {
  const client = new ApiClient({
    baseUrl: process.env.BACKEND_INTERNAL_URL || "http://localhost:8000",
    headers: internalAuth(process.env.INTERNAL_API_SECRET || "", userId),
  });
  const bind = (name: string, formatResult: (data: unknown) => string) =>
    toPiAgentTool(requireEntry(name), {
      client,
      pathOverride: INTERNAL_BINDINGS[name],
      fixedArgs: { project_id: projectId },
      formatResult,
    }) as AgentTool<any>;
  return [
    bind("list_traces", formatTraceList),
    bind("list_sessions", formatSessionList),
    bind("get_session", formatSessionDetail),
  ];
}
