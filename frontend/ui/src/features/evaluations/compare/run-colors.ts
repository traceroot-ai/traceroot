/**
 * Each compared run's colour. While the page is open, a run keeps its colour for as long
 * as it stays in the comparison: picking another baseline, adding a run, or removing
 * another run never recolours it, so a dot always means the same run in the legend and in
 * every cell. The colours live in the page's state, so a page opened again (a reload, or
 * Back from a run) colours the runs afresh in the URL's order.
 */
import * as React from "react";

// Teal and orange read close to emerald and amber at dot size, so they come last: the first
// six runs get colours that are easy to tell apart.
export const RUN_DOTS = [
  "bg-sky-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-rose-500",
  "bg-indigo-500",
  "bg-teal-500",
  "bg-orange-500",
];

/** Colour slots for `runIds`: a run that already had a slot keeps it, and a new run takes
 *  the lowest slot no selected run is using, in selection order. */
export function assignColorSlots(
  previous: ReadonlyMap<string, number>,
  runIds: readonly string[],
): Map<string, number> {
  const slots = new Map<string, number>();
  for (const id of runIds) {
    const slot = previous.get(id);
    if (slot !== undefined) slots.set(id, slot);
  }
  const used = new Set(slots.values());
  let free = 0;
  for (const id of runIds) {
    if (slots.has(id)) continue;
    while (used.has(free)) free += 1;
    slots.set(id, free);
    used.add(free);
  }
  return slots;
}

/** The dot colour of each selected run, kept across changes to the selection. */
export function useRunDots(runIds: readonly string[]): (runId: string) => string {
  const key = runIds.join(",");
  const [current, setCurrent] = React.useState(() => ({
    key,
    slots: assignColorSlots(new Map(), runIds),
  }));
  // Derive the next slots from the previous ones while rendering, not in an effect, so a
  // changed selection never paints one frame with recoloured runs.
  let slots = current.slots;
  if (current.key !== key) {
    slots = assignColorSlots(current.slots, runIds);
    setCurrent({ key, slots });
  }
  return React.useCallback(
    (runId: string) => RUN_DOTS[(slots.get(runId) ?? 0) % RUN_DOTS.length],
    [slots],
  );
}
