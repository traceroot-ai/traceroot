// The Measure hover panel's vocabulary, shared by the alert form and the widget
// builder so the two dropdowns cannot word the same measure differently.

export interface MeasureDoc {
  // Unit of the raw column: `count` and `uniq` discard it, so the panel labels
  // it the measure's unit, not the result's.
  unit: string;
  description: string;
}

/**
 * The `count` type shows as "Integer" because "Count" is also an aggregation
 * name and would read as a tautology on the Count row.
 */
export const MEASURE_TYPE_LABEL = {
  number: "Number",
  string: "String",
  count: "Integer",
} as const satisfies Record<string, string>;
