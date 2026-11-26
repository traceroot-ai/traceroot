import { prisma } from "@traceroot/core";
import { demoWorkspaceId } from "@/lib/demo-workspace";

/** The demo project's traces, for an email link; the app itself when there is no demo. */
export async function demoProjectUrl(appUrl: string): Promise<string> {
  const demoId = demoWorkspaceId();
  if (!demoId) return appUrl;
  const project = await prisma.project.findFirst({
    where: { workspaceId: demoId, deleteTime: null },
    orderBy: { createTime: "asc" },
    select: { id: true },
  });
  return project ? `${appUrl}/projects/${project.id}/traces` : appUrl;
}
