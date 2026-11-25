import type { Role } from "@traceroot/core";
import { z } from "zod";
import { requireAuth, requireProjectAccess } from "@/lib/auth-helpers";

export const labelValueSchema = z.string().trim().min(1).max(100);
export const labelDescriptionSchema = z.string().trim().max(500).nullable();
export const labelTargetIdSchema = z.string().min(1).max(128);
export const projectLabelSelect = { id: true, name: true, description: true } as const;

export async function requireLabelProject(projectId: string, minRole?: Role) {
  const auth = await requireAuth();
  if (auth.error) return { error: auth.error };
  const access = await requireProjectAccess(auth.user.id, projectId, minRole);
  if (access.error) return { error: access.error };
  return { user: auth.user, project: access.project };
}
