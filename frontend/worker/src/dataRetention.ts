/**
 * Data Retention Worker
 *
 * Runs daily to enforce per-plan trace/span retention windows:
 *   Free       → 15 days
 *   Starter    → 30 days
 *   Pro        → 90 days
 *   Enterprise → custom (traceTtlDays on each Project), skipped if unset
 *
 * For each workspace the job groups projects by their effective TTL and calls
 * the Python backend to delete ClickHouse rows and S3 raw objects older than
 * the cutoff date.  The job is a no-op when billing is disabled (ENABLE_BILLING=false).
 */

import { prisma, PlanType, getRetentionDays } from "@traceroot/core";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

interface CleanupResponse {
  status: string;
  project_ids: string[];
  ttl_days: number;
  cutoff_date: string;
  s3_objects_deleted: number;
}

async function callRetentionCleanup(
  projectIds: string[],
  ttlDays: number,
): Promise<CleanupResponse> {
  const url = new URL("/api/v1/internal/retention/cleanup", BACKEND_URL);
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_API_SECRET,
    },
    body: JSON.stringify({ project_ids: projectIds, ttl_days: ttlDays }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Backend retention cleanup error: ${response.status} - ${errorText}`);
  }

  return response.json() as Promise<CleanupResponse>;
}

/**
 * Main data retention job.
 *
 * Iterates all workspaces, determines the effective retention window from
 * the billing plan (and per-project traceTtlDays for Enterprise), and
 * triggers cleanup via the Python backend.
 */
export async function runDataRetentionJob(): Promise<void> {
  console.log("[Retention] Starting data retention job...");

  const workspaces = await prisma.workspace.findMany({
    include: {
      projects: {
        where: { deleteTime: null },
        select: { id: true, traceTtlDays: true },
      },
    },
  });

  console.log(`[Retention] Processing ${workspaces.length} workspaces`);

  let totalProjectsCleaned = 0;
  let totalS3Deleted = 0;

  for (const workspace of workspaces) {
    if (workspace.projects.length === 0) continue;

    const plan = workspace.billingPlan as PlanType;

    try {
      // Group projects by their effective TTL so we issue one API call per TTL value.
      const byTtl = new Map<number, string[]>();

      for (const project of workspace.projects) {
        const ttlDays = getRetentionDays(plan, project.traceTtlDays);
        if (ttlDays === null) {
          // No retention limit (billing disabled or Enterprise without custom TTL)
          continue;
        }
        const ids = byTtl.get(ttlDays) ?? [];
        ids.push(project.id);
        byTtl.set(ttlDays, ids);
      }

      if (byTtl.size === 0) continue;

      for (const [ttlDays, projectIds] of byTtl) {
        try {
          const result = await callRetentionCleanup(projectIds, ttlDays);
          totalProjectsCleaned += projectIds.length;
          totalS3Deleted += result.s3_objects_deleted;
          console.log(
            `[Retention] Workspace ${workspace.id} (${plan}): ` +
              `cleaned ${projectIds.length} project(s) with ttl=${ttlDays}d, ` +
              `cutoff=${result.cutoff_date}, s3_deleted=${result.s3_objects_deleted}`,
          );
        } catch (err) {
          console.error(
            `[Retention] Failed cleanup for workspace ${workspace.id}, ttl=${ttlDays}d:`,
            err,
          );
        }
      }
    } catch (err) {
      console.error(`[Retention] Error processing workspace ${workspace.id}:`, err);
    }
  }

  console.log(
    `[Retention] Job completed: ${totalProjectsCleaned} project(s) cleaned, ` +
      `${totalS3Deleted} S3 objects deleted`,
  );
}
