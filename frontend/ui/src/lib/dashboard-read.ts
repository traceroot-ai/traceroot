import { prisma } from "@traceroot/core";
import { demoWorkspaceId } from "@/lib/demo-workspace";

export const DEMO_CREATOR = "Demo";

export async function isDemoProject(projectId: string): Promise<boolean> {
  const workspaceId = demoWorkspaceId();
  return !!(
    workspaceId &&
    (await prisma.project.findFirst({
      where: { id: projectId, workspaceId, deleteTime: null },
      select: { id: true },
    }))
  );
}

/**
 * Resolve dashboard creator ids to display names for the dashboard read
 * routes (cookie list and internal mirrors). Dashboards are shared across a
 * project's members, so reads show who created each one. createdBy holds a
 * bare user id (no relation on the model); resolve display names in one
 * batch — a deleted account resolves to null.
 */
export async function resolveCreatorNames(
  ids: string[],
  projectId: string,
): Promise<Map<string, string>> {
  if (await isDemoProject(projectId)) {
    return new Map(ids.map((id) => [id, DEMO_CREATOR]));
  }
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, name: true, email: true },
  });
  // || not ??: an empty-string name must fall through to the email too.
  return new Map(users.map((u) => [u.id, u.name || u.email]));
}
