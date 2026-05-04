import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Executor } from "../executors/interface.js";
import { createQueryTracesTool } from "./query-traces.js";
import { createQuerySessionsTool } from "./query-sessions.js";
import { createDownloadTracesTool } from "./download-traces.js";
import { createDownloadSessionTool } from "./download-session.js";
import { createBashTool, createReadTool, createWriteTool } from "./sandbox.js";
import { createCheckGitHubAccessTool } from "./github-access.js";
import { createGitCloneTool } from "./git-clone.js";

const UI_BASE_URL = process.env.TRACEROOT_UI_URL || "http://localhost:3000";

/**
 * Create all tools for the agent.
 *
 * Two types:
 * - Host-side tools: run on host, call FastAPI directly
 * - Sandbox-side tools: run inside Docker container via executor
 */
export function createTools(params: {
  projectId: string;
  userId: string;
  workspaceId: string;
  executor: Executor;
}): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [];

  // Host-side tools (run on host, call FastAPI directly)
  tools.push(createQueryTracesTool(params.projectId, params.userId));
  tools.push(createQuerySessionsTool(params.projectId, params.userId));
  tools.push(createDownloadTracesTool(params.projectId, params.userId, params.executor));
  tools.push(createDownloadSessionTool(params.projectId, params.userId, params.executor));

  // GitHub tools (host-side, workspace-scoped — installation lives at workspace level)
  tools.push(createCheckGitHubAccessTool(params.workspaceId, UI_BASE_URL));
  tools.push(createGitCloneTool(params.workspaceId, UI_BASE_URL, params.executor));

  // Sandbox-side tools (run inside Docker container via executor)
  tools.push(createBashTool(params.executor));
  tools.push(createReadTool(params.executor));
  tools.push(createWriteTool(params.executor));

  return tools;
}
