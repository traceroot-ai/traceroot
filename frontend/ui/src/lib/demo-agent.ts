import { isDemoViewer } from "@/lib/demo-workspace";

export const DEMO_AGENT_READ_ONLY = "Demo conversations are read-only.";

/** Call only after authenticating the caller and resolving project membership. */
export function demoAgentWriteDenied(workspaceId: string, role: string): Response | null {
  return isDemoViewer(workspaceId, role)
    ? Response.json({ error: DEMO_AGENT_READ_ONLY }, { status: 403 })
    : null;
}
