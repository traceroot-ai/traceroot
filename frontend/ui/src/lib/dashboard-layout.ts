// Creating a widget and giving it a spot in its dashboard's grid layout, and
// deleting one and taking its spot away, for every write path (the write
// services and the cookie-session UI routes). Kept in one place because the
// layout column is a read-modify-write: getting the locking wrong on any path
// loses placements.

import type { Prisma } from "@prisma/client";
import {
  appendWidgetPlacement,
  removeWidgetPlacement,
} from "@/features/dashboards/widget-placement";
import type { WidgetType } from "@/features/dashboards/types";

type Tx = Pick<Prisma.TransactionClient, "dashboard" | "$queryRaw">;

/**
 * Lock a dashboard's row until the transaction ends and return the layout it
 * holds at that point. Every rewrite of the layout column takes this lock
 * before reading the row, so concurrent rewrites see each other's result
 * rather than each other's starting point.
 *
 * Args:
 *   tx: Transaction client. The lock is only held for a real transaction.
 *   dashboardId: The dashboard to lock.
 *   projectId: The project the caller is scoped to. The lock is taken only
 *     on a row inside it, so a dashboard id from another project locks
 *     nothing rather than contending with that project's writes.
 *
 * Returns:
 *   The stored layout, as read under the lock; an empty array when no row
 *   matched. Callers that re-read the row themselves may ignore it.
 */
export async function lockDashboardLayout(
  tx: Tx,
  dashboardId: string,
  projectId: string,
): Promise<unknown> {
  // Raw because Prisma has no row-lock API. Column and table names are the
  // mapped ones from the schema, not the client's field names.
  const locked = await tx.$queryRaw<
    { layout: unknown }[]
  >`SELECT layout FROM dashboards WHERE id = ${dashboardId} AND project_id = ${projectId} FOR UPDATE`;
  return locked[0]?.layout ?? [];
}

/**
 * Create a widget and place it in its dashboard's layout, in one transaction.
 *
 * Concurrent creates against the same dashboard would otherwise each read the
 * layout, append their own entry, and write back — the last writer dropping
 * the other's placement (its widget then falls back to the grid's unpersisted
 * client placement). The locking read serializes them: the second transaction
 * blocks until the first commits and then reads the layout it wrote.
 *
 * The lock has to be taken before the insert, not after: the widget's foreign
 * key makes the insert itself take a weaker lock on the same dashboard row,
 * and two transactions trying to upgrade that to FOR UPDATE deadlock.
 *
 * Args:
 *   tx: Transaction client. Locks are only held for a real transaction.
 *   widget: Dashboard and project to place into and the new widget's type,
 *     which decides the tile's default size.
 *   createWidget: Creates the widget row; called with the lock held.
 *
 * Returns:
 *   Whatever createWidget returned.
 */
export async function createWidgetWithPlacement<T extends { id: string }>(
  tx: Tx,
  widget: { dashboardId: string; projectId: string; type: WidgetType },
  createWidget: () => Promise<T>,
): Promise<T> {
  const stored = await lockDashboardLayout(tx, widget.dashboardId, widget.projectId);

  const created = await createWidget();

  const layout = appendWidgetPlacement(stored, { id: created.id, type: widget.type });
  if (layout) {
    await tx.dashboard.update({ where: { id: widget.dashboardId }, data: { layout } });
  }
  return created;
}

/**
 * Delete a widget and drop its entry from its dashboard's layout, in one
 * transaction, under the same row lock the create takes and for the same
 * reason: two concurrent layout rewrites would otherwise lose one of them.
 * Locking first serializes this rewrite with concurrent creates and deletes
 * on the same layout, so each one reads the layout the previous one wrote.
 *
 * Args:
 *   tx: Transaction client. Locks are only held for a real transaction.
 *   widget: The widget's id, its dashboard and the dashboard's project.
 *   deleteWidget: Deletes the widget row; called with the lock held.
 *
 * Returns:
 *   Whatever deleteWidget returned.
 */
export async function deleteWidgetWithPlacement<T>(
  tx: Tx,
  widget: { id: string; dashboardId: string; projectId: string },
  deleteWidget: () => Promise<T>,
): Promise<T> {
  const stored = await lockDashboardLayout(tx, widget.dashboardId, widget.projectId);

  const deleted = await deleteWidget();

  const layout = removeWidgetPlacement(stored, widget.id);
  if (layout) {
    await tx.dashboard.update({ where: { id: widget.dashboardId }, data: { layout } });
  }
  return deleted;
}
