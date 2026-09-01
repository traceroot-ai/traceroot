import { randomUUID } from "node:crypto";
import type { EvalFixture, EvalPrisma, EvalUser } from "./types.js";

/** Misconfiguration the runner reports as guidance rather than a stack trace. */
export class EvalConfigError extends Error {}

/**
 * The account the eval runs as, from EVAL_USER_EMAIL.
 *
 * Required, with no fallback: a default address would be some real person's
 * account on whichever stack the eval happens to point at, and the eval both
 * writes as that user and tears fixtures down afterwards.
 */
export function requireEvalUserEmail(env: NodeJS.ProcessEnv = process.env): string {
  const email = env.EVAL_USER_EMAIL?.trim();
  if (!email) {
    throw new EvalConfigError(
      "EVAL_USER_EMAIL is not set — point it at an existing account on this stack, " +
        "e.g. EVAL_USER_EMAIL=you@example.com pnpm --filter @traceroot/agent evals",
    );
  }
  return email;
}

/**
 * Resolve the account the eval runs as, plus a workspace it can create the
 * fixture project in. No ids are hardcoded — everything hangs off the email.
 */
export async function resolveEvalUser(prisma: EvalPrisma, email: string): Promise<EvalUser> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) {
    throw new Error(
      `no user with email "${email}" on this stack — set EVAL_USER_EMAIL to an existing account`,
    );
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: { userId: user.id },
    select: { workspaceId: true },
    orderBy: { createTime: "asc" },
  });
  if (!membership) {
    throw new Error(
      `user "${email}" belongs to no workspace, so the eval project has nowhere to live`,
    );
  }

  return { id: user.id, email: user.email, workspaceId: membership.workspaceId };
}

/**
 * Create the throwaway project every scenario writes into.
 *
 * It gets a "Default" dashboard because production seeds one at project
 * creation and the widget scenarios expect somewhere to attach to — but
 * deliberately *without* the starter widgets. Two of those seeded widgets
 * already break spans down by model, which would satisfy the traces-by-model
 * assertion before the agent did anything; keeping the dashboard empty means
 * every widget row in the project is one the agent wrote.
 */
export async function createEvalProject(
  prisma: EvalPrisma,
  { user, runId }: { user: EvalUser; runId: string },
): Promise<EvalFixture> {
  const projectName = `agent-eval-${runId}`;

  // `projects.id` carries no database default; every writer supplies its own.
  const project = await prisma.project.create({
    data: { id: randomUUID(), workspaceId: user.workspaceId, name: projectName },
  });

  await prisma.dashboard.create({
    data: {
      id: `default_${project.id}`,
      projectId: project.id,
      name: "Default",
      description: "Eval fixture dashboard.",
      isDefault: true,
      createdBy: user.id,
      layout: [],
    },
  });

  return { runId, user, projectId: project.id, projectName };
}

/**
 * Drop the fixture project and everything it owns.
 *
 * Deleting the project row cascades to its agent sessions (and their
 * messages), detectors, dashboards and widgets. Audit rows are the exception:
 * they intentionally carry no foreign key so history survives deletion, so
 * they have to go first and explicitly.
 */
export async function teardownEvalProject(prisma: EvalPrisma, projectId: string): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
}
