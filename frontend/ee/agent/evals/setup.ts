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
 * Writes and removes the fixture project's ClickHouse rows.
 *
 * Injected rather than imported so the fixture helpers stay unit-testable
 * against a fake, and so a run can be asked for an unseeded project by
 * passing nothing.
 */
export interface EvalSeeder {
  /** Write the deterministic dataset for `projectId`, dated from `anchor`. */
  seed(projectId: string, anchor: Date): Promise<unknown>;
  /** Remove it again. Used on rollback and at teardown. */
  unseed(projectId: string): Promise<unknown>;
  /** Rows still carrying the project after unseed, per table; the teardown check. */
  count?(projectId: string): Promise<{ traces: number; spans: number }>;
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
 *
 * With a `seeder`, the project also gets its ClickHouse dataset, written
 * after both rows exist and anchored to the caller's clock so the run and its
 * assertions agree on what "8 days ago" means.
 *
 * All of it is all-or-nothing. A dashboard or seed failure after the project
 * row lands would otherwise abort the run before teardown ever runs, leaving
 * a fixture project — and its spans — behind on a shared stack for every
 * attempt.
 */
export async function createEvalProject(
  prisma: EvalPrisma,
  {
    user,
    runId,
    anchor = new Date(),
    seeder,
  }: { user: EvalUser; runId: string; anchor?: Date; seeder?: EvalSeeder },
): Promise<EvalFixture> {
  const projectName = `agent-eval-${runId}`;

  // `projects.id` carries no database default; every writer supplies its own.
  const project = await prisma.project.create({
    data: { id: randomUUID(), workspaceId: user.workspaceId, name: projectName },
  });

  try {
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
    await seeder?.seed(project.id, anchor);
  } catch (failure) {
    // Swallowed so the caller sees why the fixture could not be built, not
    // why the cleanup of it failed. A partial seed is cleaned up first: the
    // spans it did write outlive the project row, which cascades away.
    await seeder?.unseed(project.id).catch(() => {});
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    throw failure;
  }

  return { runId, user, projectId: project.id, projectName };
}

/**
 * Drop the fixture project and everything it owns.
 *
 * Deleting the project row cascades to its agent sessions (and their
 * messages), detectors, dashboards and widgets. Two exceptions go explicitly:
 * audit rows, which intentionally carry no foreign key so history survives
 * deletion, and the seeded ClickHouse rows, which live in another database
 * entirely and no cascade can reach.
 *
 * A failed unseed does not cost the project deletion — the orphan rows are
 * inert, an orphan project on a shared stack is not — but it is re-thrown
 * afterwards so the run says the spans are still there.
 */
export async function teardownEvalProject(
  prisma: EvalPrisma,
  projectId: string,
  seeder?: EvalSeeder,
): Promise<void> {
  let unseedFailure: unknown;
  if (seeder) {
    try {
      await seeder.unseed(projectId);
      const left = await seeder.count?.(projectId);
      if (left && left.traces + left.spans > 0) {
        console.error(
          `fixture project ${projectId} still has ${left.traces} trace and ${left.spans} span rows after unseed`,
        );
      }
    } catch (failure) {
      unseedFailure = failure;
    }
  }
  await prisma.auditLog.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  if (unseedFailure !== undefined) throw unseedFailure;
}
