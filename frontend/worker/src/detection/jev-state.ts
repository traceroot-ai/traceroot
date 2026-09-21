/**
 * Projects a trace's spans.jsonl (one ClickHouse `spans` row per line) into the
 * `state` sent to TypeSafe's System One (Jev), parsing JSON-string payloads so
 * Jev reads real structure instead of escaped text.
 *
 * Jev's limit is in tokens, so the state is held to a character budget by a
 * deterministic reduction: truncate inputs, drop metadata, truncate outputs
 * (head and tail), then drop middle spans behind an `omitted_spans` marker. A
 * state still over budget throws; the caller fails the run.
 */

import type { JsonValue } from "./typesafe-client.js";

/** A 60k-char state measured ~14k input tokens against the live API. */
const JEV_STATE_BUDGET_CHARS = 60_000;

const CAPS = [8_000, 4_000, 2_000, 1_000, 500, 200] as const;
const TIGHTEST_CAP = CAPS[CAPS.length - 1];

/** Columns kept from each spans row, in output order. Anything else (ids,
 * timestamps, cost, token counts, internal flags, future columns) is dropped. */
const KEPT_COLUMNS = [
  "name",
  "span_kind",
  "status",
  "status_message",
  "model_name",
  "input",
  "output",
  "metadata",
  "environment",
  "git_source_file",
  "git_source_line",
  "git_source_function",
] as const;

const JSON_STRING_COLUMNS = new Set<string>(["input", "output", "metadata"]);

const METADATA_COLUMNS = [
  "metadata",
  "environment",
  "git_source_file",
  "git_source_line",
  "git_source_function",
] as const;

type SpanState = { [key: string]: JsonValue };

interface Step {
  inputCap: number;
  dropMetadata?: boolean;
  outputCap?: number;
}

const STEPS: Step[] = [
  ...CAPS.map((inputCap) => ({ inputCap })),
  { inputCap: TIGHTEST_CAP, dropMetadata: true },
  ...CAPS.map((outputCap) => ({ inputCap: TIGHTEST_CAP, dropMetadata: true, outputCap })),
];

interface Reduction {
  spans: SpanState[];
  step: Step | null;
  truncatedInputs: number;
  truncatedOutputs: number;
}

export interface JevState {
  state: JsonValue;
  stats: Record<string, number>;
}

/** Parse a string that holds a JSON object, array or string; otherwise keep the text. */
function parseJsonString(text: string): JsonValue {
  const head = text.trimStart()[0];
  if (head !== "{" && head !== "[" && head !== '"') return text;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

function projectSpan(row: Record<string, unknown>): SpanState {
  const span: SpanState = {};
  for (const column of KEPT_COLUMNS) {
    const value = row[column];
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "string") {
      span[column] = JSON_STRING_COLUMNS.has(column) ? parseJsonString(value) : value;
    } else {
      span[column] = value as JsonValue;
    }
  }
  return span;
}

/** With `keepTail`, keeps the head and the tail, so an output's final result survives. */
function truncate(value: JsonValue, cap: number, keepTail: boolean): JsonValue {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= cap) return value;
  const marker = `…[truncated ${text.length - cap} chars]`;
  if (!keepTail) return `${text.slice(0, cap)}${marker}`;
  const tail = Math.floor(cap / 2);
  return `${text.slice(0, cap - tail)}${marker}…${text.slice(text.length - tail)}`;
}

function applyReductions(spans: SpanState[], step: Step): Reduction {
  let truncatedInputs = 0;
  let truncatedOutputs = 0;
  const reduced = spans.map((span) => {
    const out: SpanState = { ...span };
    if (out.input !== undefined) {
      const before = out.input;
      out.input = truncate(before, step.inputCap, false);
      if (out.input !== before) truncatedInputs++;
    }
    if (step.dropMetadata) {
      for (const column of METADATA_COLUMNS) delete out[column];
    }
    if (step.outputCap !== undefined && out.output !== undefined) {
      const before = out.output;
      out.output = truncate(before, step.outputCap, true);
      if (out.output !== before) truncatedOutputs++;
    }
    return out;
  });
  return { spans: reduced, step, truncatedInputs, truncatedOutputs };
}

function wrap(traceId: string | null, spanCount: number, spans: JsonValue[]): JsonValue {
  return { trace: { trace_id: traceId, span_count: spanCount, spans } };
}

/** Throws when the state cannot fit the budget. */
export function buildJevState(spansJsonl: string, opts?: { budgetChars?: number }): JevState {
  const budget = opts?.budgetChars ?? JEV_STATE_BUDGET_CHARS;

  let traceId: string | null = null;
  let skippedLines = 0;
  const spans: SpanState[] = [];
  for (const line of spansJsonl.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      skippedLines++;
      continue;
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      skippedLines++;
      continue;
    }
    const record = row as Record<string, unknown>;
    if (traceId === null && typeof record.trace_id === "string") traceId = record.trace_id;
    spans.push(projectSpan(record));
  }

  const spanCount = spans.length;
  const size = (s: JsonValue[]) => JSON.stringify(wrap(traceId, spanCount, s)).length;
  const originalChars = size(spans);

  const stats = (finalChars: number, r: Reduction, omittedSpans: number) => ({
    span_count: spanCount,
    kept_spans: spanCount - omittedSpans,
    omitted_spans: omittedSpans,
    truncated_inputs: r.truncatedInputs,
    input_cap_chars: r.step?.inputCap ?? 0,
    dropped_metadata: r.step?.dropMetadata ? 1 : 0,
    truncated_outputs: r.truncatedOutputs,
    output_cap_chars: r.step?.outputCap ?? 0,
    skipped_lines: skippedLines,
    original_chars: originalChars,
    final_chars: finalChars,
    budget_chars: budget,
  });

  let last: Reduction = { spans, step: null, truncatedInputs: 0, truncatedOutputs: 0 };
  if (originalChars <= budget) {
    return { state: wrap(traceId, spanCount, spans), stats: stats(originalChars, last, 0) };
  }

  for (const step of STEPS) {
    last = applyReductions(spans, step);
    const chars = size(last.spans);
    if (chars <= budget) {
      return { state: wrap(traceId, spanCount, last.spans), stats: stats(chars, last, 0) };
    }
  }

  // Drop middle spans, keeping the head (root first) and the tail.
  // JSON.stringify([a,b,c]) is "[" + a + "," + b + "," + c + "]", so the size
  // for any kept set is computed from per-span lengths without re-serializing.
  const reduced = last.spans;
  const spanLengths = reduced.map((s) => JSON.stringify(s).length);
  const emptyChars = size([]);
  for (let keep = spanCount - 1; keep >= 1; keep--) {
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    const omitted = spanCount - keep;
    const marker = { omitted_spans: omitted };
    let chars = emptyChars + JSON.stringify(marker).length + keep; // keep commas for keep+1 items
    for (let i = 0; i < head; i++) chars += spanLengths[i];
    for (let i = spanCount - tail; i < spanCount; i++) chars += spanLengths[i];
    if (chars <= budget) {
      const kept: JsonValue[] = [
        ...reduced.slice(0, head),
        marker,
        ...reduced.slice(spanCount - tail),
      ];
      return { state: wrap(traceId, spanCount, kept), stats: stats(chars, last, omitted) };
    }
  }

  throw new Error(
    `Jev state does not fit the ${budget}-char budget: ` +
      `${originalChars} chars across ${spanCount} spans, still over budget after truncating ` +
      `inputs, dropping metadata, truncating outputs and keeping only the first span`,
  );
}
