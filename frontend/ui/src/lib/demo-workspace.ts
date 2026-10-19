// The public demo workspace. Every user joins it as a VIEWER, so new users can
// look at a live project before they send their own traces. DEMO_WORKSPACE_ID
// names it; unset (self-hosted) turns all of this off.
//
// The demo workspace is an ordinary workspace on the enterprise plan, so its
// quotas, seats and billing need no special code. What does need it: every
// place that lists a user's workspaces. Those queries build their `where` with
// userMembershipWhere(), which makes each caller choose whether the demo
// counts; the lint rule in frontend/eslint.config.mjs rejects a hand-written
// `where: { userId }` on workspaceMember, so a new caller cannot forget.
import { prisma, Role, type Prisma } from "@traceroot/core";

/**
 * The demo workspace id, or null when the deployment has no demo workspace.
 * Read from process.env at call time (the variable is declared in env.ts):
 * importing the parsed `env` here would make every workspace route parse the
 * whole server schema at import, which their tests do not provide.
 */
export function demoWorkspaceId(): string | null {
  return process.env.DEMO_WORKSPACE_ID?.trim() || null;
}

export function isDemoWorkspace(workspaceId: string): boolean {
  const demoId = demoWorkspaceId();
  return demoId !== null && workspaceId === demoId;
}

/**
 * A member of the demo workspace below ADMIN: every visitor, but not our team.
 * They can read the demo project, but not the settings behind it (keys, model
 * providers, integrations, billing, alert recipients). The UI shows them an
 * access-denied card for those pages; these routes are the real check.
 */
export function isDemoViewer(workspaceId: string, role: string): boolean {
  return isDemoWorkspace(workspaceId) && role !== Role.ADMIN;
}

/** The 403 message for a settings read that demo viewers cannot make. */
export const DEMO_VIEWER_FORBIDDEN = "Not available in the demo workspace";

/**
 * Whether a query over one user's memberships counts the demo workspace.
 * "include-demo" for surfaces that show the demo (the workspace list);
 * "exclude-demo" for decisions about the user's own workspaces (onboarding,
 * "your only workspace").
 */
export type DemoWorkspaceChoice = "include-demo" | "exclude-demo";

/** The `where` for a query over one user's workspace memberships. */
export function userMembershipWhere(
  userId: string,
  demo: DemoWorkspaceChoice,
): Prisma.WorkspaceMemberWhereInput {
  const demoId = demoWorkspaceId();
  if (demo === "exclude-demo" && demoId !== null) {
    return { userId, workspaceId: { not: demoId } };
  }
  return { userId };
}

/** Move the demo workspace to the end; the rest keep their order. */
export function sortDemoLast<T>(items: T[], workspaceIdOf: (item: T) => string): T[] {
  const rank = (item: T) => (isDemoWorkspace(workspaceIdOf(item)) ? 1 : 0);
  return [...items].sort((a, b) => rank(a) - rank(b));
}

type MemberClient = Pick<typeof prisma, "workspaceMember">;

/**
 * Add the user to the demo workspace as a VIEWER. An existing membership is
 * left as it is, so a team admin is never lowered to VIEWER. Runs after
 * sign-up and at each login; it logs and never throws, so a demo problem can
 * never break sign-in.
 */
export async function ensureDemoMembership(
  userId: string,
  client: MemberClient = prisma,
): Promise<void> {
  const workspaceId = demoWorkspaceId();
  if (workspaceId === null) return;
  try {
    await client.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      update: {},
      create: { id: crypto.randomUUID(), workspaceId, userId, role: Role.VIEWER },
    });
  } catch (error) {
    console.error(`[demo-workspace] could not add user ${userId} to the demo workspace:`, error);
  }
}
