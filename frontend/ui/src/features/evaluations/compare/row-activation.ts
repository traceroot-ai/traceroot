/**
 * Whether a click inside a comparison row (or a case's group of lines) opens its case.
 * Controls inside it act on their own (buttons, links, inputs, anything else focusable).
 * A label that is focusable only to show a tooltip (`data-tooltip-trigger`) is part of the
 * row's content, so a click on it opens the case like a click on the text around it, and
 * so is a line that is the group's tab stop. A click on something portalled out of the
 * row (a tooltip's content) reaches it through React but isn't in it.
 */
const ROW_CONTROLS =
  'a, button, input, select, textarea, [role="button"], [tabindex]:not([data-tooltip-trigger]):not(tr)';

export function clickOpensRow(target: Element, row: Element): boolean {
  if (!row.contains(target)) return false;
  const control = target.closest(ROW_CONTROLS);
  return !control || control === row || !row.contains(control);
}
