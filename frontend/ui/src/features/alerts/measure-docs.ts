// Every sentence describes the column a measure reads, at span grain. The two
// unique-id measures read from `traces`; see SOURCE_BY_ALERT_MEASURE in
// frontend/packages/core/src/alerts.ts for why that is the same number.

import { ALERT_MEASURES_BY_VIEW, type AlertView, type MeasureType } from "./rule-model";

/**
 * The `count` type shows as "Integer" because "Count" is also an aggregation
 * name and would read as a tautology on the Count row.
 */
export const MEASURE_TYPE_LABEL: Record<MeasureType, string> = {
  number: "Number",
  string: "String",
  count: "Integer",
};

export interface AlertMeasureDoc {
  // Unit of the raw column: `count` and `uniq` discard it, so the panel labels
  // it the measure's unit, not the alert's.
  unit: string;
  description: string;
  // Why a measure cannot return a number. Absent means available; nothing sets
  // it today, but the panel must never go silent about a dead measure.
  unavailable?: string;
}

export const ALERT_MEASURE_DOCS: Record<AlertView, Record<string, AlertMeasureDoc>> = {
  SPANS: {
    count: {
      unit: "Spans",
      description: "Number of spans in the window.",
    },
    trace_id: {
      unit: "Traces",
      description:
        "Trace identifier recorded on every span; aggregate with uniq to count distinct traces.",
    },
    latency: {
      unit: "Milliseconds",
      description: "Elapsed time of one span, from its start time to its end time.",
    },
    cost: {
      unit: "USD",
      description: "Cost recorded on one span.",
    },
    input_tokens: {
      unit: "Tokens",
      description: "Input tokens recorded on one span.",
    },
    output_tokens: {
      unit: "Tokens",
      description: "Output tokens recorded on one span.",
    },
    total_tokens: {
      unit: "Tokens",
      description: "Input plus output tokens recorded on one span.",
    },
    total_tokens_per_second: {
      unit: "Tokens per second",
      description:
        "A span's total tokens over its millisecond duration, as a per-second rate; a span with no measured duration has no value.",
    },
    unique_user_ids: {
      unit: "Users",
      description:
        "Identifier of the user a trace belongs to; aggregate with uniq to count distinct users.",
    },
    unique_session_ids: {
      unit: "Sessions",
      description:
        "Identifier of the session a trace belongs to; aggregate with uniq to count distinct sessions.",
    },
  },
};

export function getMeasureDoc(view: AlertView, measureId: string): AlertMeasureDoc | undefined {
  return ALERT_MEASURE_DOCS[view][measureId];
}

// Exported so a test fails when a measure is added and the dropdown would show
// it unexplained.
export function undocumentedMeasureIds(view: AlertView): readonly string[] {
  return ALERT_MEASURES_BY_VIEW[view]
    .filter((m) => getMeasureDoc(view, m.id) === undefined)
    .map((m) => m.id);
}
