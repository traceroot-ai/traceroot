import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Executor } from "../executors/interface.js";
import { createQueryTracesTool } from "./query-traces.js";
import { createDownloadTraceTool } from "./download-trace.js";
import { createBashTool, createReadTool, createWriteTool } from "./sandbox.js";

/**
 * Create all tools for the agent. Follows Mom's createMomTools() pattern.
 *
 * Two types:
 * - Host-side tools (query_traces, download_trace): run on host, call FastAPI directly
 * - Sandbox-side tools (bash, read, write): run inside sandbox via executor
 */
export function createTools(params: {
  projectId: string;
  userId: string;
  executor: Executor;
}): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [];

  // Host-side tools (run on host, call FastAPI directly)
  tools.push(createQueryTracesTool(params.projectId, params.userId));
  tools.push(createDownloadTraceTool(params.projectId, params.userId, params.executor));

  // Sandbox-side tools (run inside Docker container via executor)
  tools.push(createBashTool(params.executor));
  tools.push(createReadTool(params.executor));
  tools.push(createWriteTool(params.executor));

  return tools;
}
