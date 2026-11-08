import type { PrismaClient } from "@prisma/client";

/** A project can ask for a fresh fit about once an hour. */
export const REFRESH_MIN_INTERVAL_MS = 60 * 60 * 1000;

export interface RefreshRequestResult {
  accepted: boolean;
  /** When the next request will be taken; null when this one was accepted. */
  nextAllowedAt: Date | null;
}

/**
 * Record a "Refresh now" request, if the project has the feature on and has not
 * asked within the last hour. One statement does the check and the write, so two
 * requests in the same instant cannot both be taken. The backend picks the request
 * up on its next tick and consumes it (it fits once per request).
 */
export async function requestTaskGroupRefresh(
  db: Pick<PrismaClient, "$queryRaw">,
  projectId: string,
  now: Date = new Date(),
): Promise<RefreshRequestResult> {
  const cutoff = new Date(now.getTime() - REFRESH_MIN_INTERVAL_MS);
  const taken = await db.$queryRaw<{ refresh_requested_at: Date }[]>`
    UPDATE task_group_settings
    SET refresh_requested_at = ${now}, update_time = ${now}
    WHERE project_id = ${projectId} AND enabled
      AND (refresh_requested_at IS NULL OR refresh_requested_at <= ${cutoff})
    RETURNING refresh_requested_at`;
  if (taken.length > 0) return { accepted: true, nextAllowedAt: null };
  const current = await db.$queryRaw<{ refresh_requested_at: Date | null }[]>`
    SELECT refresh_requested_at FROM task_group_settings
    WHERE project_id = ${projectId} AND enabled`;
  const last = current[0]?.refresh_requested_at ?? null;
  return {
    accepted: false,
    nextAllowedAt: last ? new Date(last.getTime() + REFRESH_MIN_INTERVAL_MS) : null,
  };
}
