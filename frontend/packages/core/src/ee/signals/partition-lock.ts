import type { Prisma } from "@prisma/client";

/**
 * Take the (project, detector) partition's transaction-scoped advisory lock.
 *
 * Every write to a partition's signals and hits runs under it: the assignment
 * worker's per-hit write and every UI write (status, criteria edit, merge, move).
 * It is held only for those short writes; no model call ever runs under it.
 * Released when the transaction ends. Two partitions whose keys hash alike only
 * serialize, which is harmless.
 *
 * `$executeRaw`, not `$queryRaw`: pg_advisory_xact_lock returns `void`, which
 * Prisma cannot deserialize as a result column.
 */
export async function lockSignalPartition(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  projectId: string,
  detectorId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('signals'), hashtext(${projectId} || ':' || ${detectorId}))`;
}
