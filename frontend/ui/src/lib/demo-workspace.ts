import { env } from "@/env";

/**
 * Whether `workspaceId` is the read-only demo workspace named by
 * DEMO_WORKSPACE_ID. Always false when the setting is unset or blank.
 */
export function isDemoWorkspace(workspaceId: string): boolean {
  const demoId = env.DEMO_WORKSPACE_ID?.trim();
  return !!demoId && workspaceId === demoId;
}
