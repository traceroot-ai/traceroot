// Creating a widget and giving it a spot in its dashboard's grid layout, for
// both write paths (the public/agent write service and the cookie-session UI
// route). Kept in one place because the layout column is a read-modify-write:
// getting the locking wrong on either path loses placements.

import type { Prisma } from "@prisma/client";
import { appendWidgetPlacement } from "@/features/dashboards/widget-placement";
import type { WidgetType } from "@/features/dashboards/types";

type Tx = Pick<Prisma.TransactionClient, "dashboard" | "$queryRaw">;

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
 *   widget: Dashboard to place into and the new widget's type, which decides
 *     the tile's default size.
 *   createWidget: Creates the widget row; called with the lock held.
 *
 * Returns:
 *   Whatever createWidget returned.
 */
export async function createWidgetWithPlacement<T extends { id: string }>(
  tx: Tx,
  widget: { dashboardId: string; type: WidgetType },
  createWidget: () => Promise<T>,
): Promise<T> {
  // Raw because Prisma has no row-lock API. Column and table names are the
  // mapped ones from the schema, not the client's field names.
  const locked = await tx.$queryRaw<
    { layout: unknown }[]
  >`SELECT layout FROM dashboards WHERE id = ${widget.dashboardId} FOR UPDATE`;

  const created = await createWidget();

  const layout = appendWidgetPlacement(locked[0]?.layout ?? [], {
    id: created.id,
    type: widget.type,
  });
  if (layout) {
    await tx.dashboard.update({ where: { id: widget.dashboardId }, data: { layout } });
  }
  return created;
}
