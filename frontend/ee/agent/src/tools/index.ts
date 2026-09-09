import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ApiClient, internalAuth } from "@traceroot-ai/tools";
import type { Executor } from "../executors/interface.js";
import { createRegistryReadTools } from "./registry-tools.js";
import { createRegistryWriteTools } from "./registry-write-tools.js";
import { createDownloadTracesTool } from "./download-traces.js";
import { createDownloadSessionTool } from "./download-session.js";
import { createBashTool, createReadTool, createWriteTool } from "./sandbox.js";
import { createCheckGitHubAccessTool } from "./github-access.js";
import { createGitCloneTool } from "./git-clone.js";
import type { QueryWindow } from "./query-window.js";
import { internalUiUrl } from "./origins.js";

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
  /** Conversation session recorded as provenance on writes. */
  agentSessionId: string;
  executor: Executor;
  /** The page's selected time range, the default window for dashboard reads. */
  window?: QueryWindow;
}): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [];

  // Host-side tools (run on host, call FastAPI directly)
  tools.push(...createRegistryReadTools(params.projectId, params.userId, params.window));

  // Write tools (host-side, call the UI app's internal write routes). Only
  // offered when there is an acting user to attribute the write to and a
  // session to record as provenance — system/RCA sessions get no write tools.
  if (params.userId && params.agentSessionId) {
    const client = new ApiClient({
      baseUrl: internalUiUrl(),
      headers: internalAuth(process.env.INTERNAL_API_SECRET || "", params.userId),
    });
    tools.push(
      ...createRegistryWriteTools({
        client,
        actorUserId: params.userId,
        agentSessionId: params.agentSessionId,
        projectId: params.projectId,
      }),
    );
  }
  tools.push(createDownloadTracesTool(params.projectId, params.userId, params.executor));
  tools.push(createDownloadSessionTool(params.projectId, params.userId, params.executor));

  // GitHub tools (host-side, workspace-scoped — installation lives at workspace level)
  tools.push(createCheckGitHubAccessTool(params.workspaceId, internalUiUrl()));
  tools.push(createGitCloneTool(params.workspaceId, internalUiUrl(), params.executor));

  // Sandbox-side tools (run inside Docker container via executor)
  tools.push(createBashTool(params.executor));
  tools.push(createReadTool(params.executor));
  tools.push(createWriteTool(params.executor));

  return tools;
}
