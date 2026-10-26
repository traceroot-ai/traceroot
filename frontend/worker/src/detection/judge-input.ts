/**
 * Renders a trace's spans.jsonl (one ClickHouse `spans` row per line) as the
 * plain text an LLM detector judge reads.
 *
 * Step 1 slims every span: only the columns that describe what happened are
 * kept, metadata values that repeat the span's input or output are dropped
 * (as are the Vercel AI SDK copies under known keys), and long metadata
 * values keep only their head and tail.
 *
 * Step 2 fits the text into the budget in passes, after PostHog's trace
 * judge: render everything; else shorten every long text to its head and tail
 * but keep LLM outputs whole; else shorten LLM outputs too; else number the
 * lines and keep an even sample of them. Unlike PostHog, a pass keeps as much
 * of each head and tail as the budget allows (SHORTEN_KEEP_CHARS at least),
 * so a trace just over the budget loses little. Every span keeps a place in
 * the text, and each cut leaves a marker the system prompt explains.
 */

import { parseJsonString } from "./jev-state.js";
import type { JsonValue } from "./typesafe-client.js";

/** Same hard cap the judge input had as raw JSONL. */
export const JUDGE_INPUT_BUDGET_CHARS = 150_000;

/** The fewest characters a shortened text keeps at each end; long metadata values always keep this many. */
const SHORTEN_KEEP_CHARS = 500;

/** Lines at the top of the text that line sampling never drops. */
const PRESERVE_HEADER_LINES = 3;
const SAMPLING_MAX_ITERATIONS = 10;
const SAMPLING_REDUCTION_FACTOR = 0.9;

/** Vercel AI SDK attributes that hold copies of the span's input or output. */
const SDK_COPY_KEYS = new Set([
  "ai.prompt",
  "ai.prompt.messages",
  "ai.response.text",
  "ai.response.object",
  "ai.response.toolCalls",
  "ai.toolCall.args",
  "ai.toolCall.result",
]);

/** Explains the text format and its markers; appended to the judge's system prompt. */
export const JUDGE_INPUT_FORMAT_NOTE = `TRACE FORMAT:
- Each span starts with "[n]", its number in start order; "parent [m]" names the span that contains it.
- To fit the trace into your context, the monitoring system may shorten long texts. "... (N chars truncated) ..." marks text the monitoring system removed, not the agent. A "[SAMPLED VIEW ...]" line means only some lines are shown; gaps in the line numbers are omitted lines.
- Never report removed or omitted text as a problem in the trace. Judge only what is shown.`;

/** One piece of text that a pass may shorten. */
interface Field {
  label: string;
  text: string;
  /** LLM outputs survive pass 2 whole. */
  llmOutput?: boolean;
}

interface SpanBlock {
  header: string;
  fields: Field[];
}

export interface JudgeInput {
  text: string;
  stats: {
    span_count: number;
    skipped_lines: number;
    /** 1: everything fits; 2: long texts shortened; 3: also LLM outputs; 4: line sampling. */
    pass: number;
    /** Characters each shortened text kept at each end; 0 when nothing was shortened. */
    keep_chars: number;
    dropped_metadata_values: number;
    shortened_texts: number;
    raw_chars: number;
    final_chars: number;
  };
}

function shorten(text: string, keep = SHORTEN_KEEP_CHARS): string {
  if (text.length <= 2 * keep) return text;
  const removed = text.length - 2 * keep;
  return `${text.slice(0, keep)}\n... (${removed} chars truncated) ...\n${text.slice(-keep)}`;
}

/** Parse JSON held in a string, twice at most: some SDKs store JSON text as a JSON string. */
function parseDeep(value: unknown): JsonValue {
  let parsed = value as JsonValue;
  for (let i = 0; i < 2 && typeof parsed === "string"; i++) {
    const next = parseJsonString(parsed);
    if (next === parsed) break;
    parsed = next;
  }
  return parsed;
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMessage(value: unknown): value is Record<string, JsonValue> {
  return isObject(value) && typeof value.role === "string";
}

function compact(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Text of one content part: OpenAI, Anthropic and Vercel AI SDK shapes. */
function partText(part: JsonValue): string {
  if (!isObject(part)) return compact(part);
  if (typeof part.text === "string") return part.text;
  const tool = part.toolName ?? part.name;
  if (part.type === "tool-call" || part.type === "tool_use") {
    return `[tool call] ${compact(tool ?? "")}(${compact(part.args ?? part.input ?? "")})`;
  }
  if (part.type === "tool-result" || part.type === "tool_result") {
    return `[tool result${tool ? ` ${compact(tool)}` : ""}] ${compact(part.result ?? part.output ?? part.content ?? "")}`;
  }
  if (part.type === "image" || part.type === "image_url" || part.type === "file") {
    return `[${part.type}]`;
  }
  return JSON.stringify(part);
}

function messageText(message: Record<string, JsonValue>): string {
  const { content } = message;
  const pieces: string[] = [];
  if (Array.isArray(content)) pieces.push(...content.map(partText));
  else if (content !== null && content !== undefined) pieces.push(compact(content));
  const calls = message.tool_calls;
  if (Array.isArray(calls)) {
    for (const call of calls) {
      const fn = isObject(call) && isObject(call.function) ? call.function : null;
      pieces.push(
        fn
          ? `[tool call] ${compact(fn.name ?? "")}(${compact(fn.arguments ?? "")})`
          : compact(call),
      );
    }
  }
  return pieces.join("\n");
}

/** Messages become one field each, so a pass shortens each message on its own. */
function valueFields(label: string, value: JsonValue, llmOutput: boolean): Field[] {
  const messages = Array.isArray(value) && value.length > 0 && value.every(isMessage);
  if (messages) {
    return (value as Record<string, JsonValue>[]).map((m) => ({
      label: `${label} ${compact(m.role)}`,
      text: messageText(m),
      llmOutput,
    }));
  }
  if (isMessage(value))
    return [{ label: `${label} ${value.role}`, text: messageText(value), llmOutput }];
  return [{ label, text: compact(value), llmOutput }];
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function durationText(row: Record<string, unknown>): string | null {
  const parse = (v: unknown) => {
    if (typeof v !== "string" || !v) return NaN;
    const iso = v.replace(" ", "T");
    return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  };
  const ms = parse(row.span_end_time) - parse(row.span_start_time);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

function present(value: unknown): value is string | number {
  return (typeof value === "string" && value !== "") || typeof value === "number";
}

function buildBlock(
  row: Record<string, unknown>,
  index: number,
  indexById: Map<string, number>,
  counters: { droppedMetadataValues: number },
): SpanBlock {
  const kind = present(row.span_kind) ? String(row.span_kind) : "SPAN";
  const parts = [`[${index}] ${present(row.name) ? row.name : "(unnamed)"}`, kind];
  if (present(row.model_name)) parts.push(String(row.model_name));
  parts.push(present(row.status) ? String(row.status) : "OK");
  const duration = durationText(row);
  if (duration) parts.push(duration);
  if (present(row.total_tokens) && Number(row.total_tokens) > 0)
    parts.push(`${row.total_tokens} tokens`);
  if (present(row.cost) && Number(row.cost) > 0) parts.push(`$${Number(row.cost)}`);
  const parent =
    typeof row.parent_span_id === "string" ? indexById.get(row.parent_span_id) : undefined;
  if (parent !== undefined) parts.push(`parent [${parent}]`);

  const fields: Field[] = [];
  if (present(row.status_message))
    fields.push({ label: "status message", text: String(row.status_message) });

  const input =
    row.input === null || row.input === undefined || row.input === ""
      ? undefined
      : parseDeep(row.input);
  const output =
    row.output === null || row.output === undefined || row.output === ""
      ? undefined
      : parseDeep(row.output);
  if (input !== undefined) fields.push(...valueFields("input", input, false));
  if (output !== undefined) fields.push(...valueFields("output", output, kind === "LLM"));

  const copies = new Set([input, output].filter((v) => v !== undefined).map((v) => canonical(v!)));
  const metadata = typeof row.metadata === "string" ? parseJsonString(row.metadata) : row.metadata;
  if (isObject(metadata)) {
    for (const [key, raw] of Object.entries(metadata)) {
      if (raw === null || raw === "") continue;
      const value = parseDeep(raw);
      if (SDK_COPY_KEYS.has(key) || copies.has(canonical(value))) {
        counters.droppedMetadataValues++;
        continue;
      }
      // Metadata is context, not evidence: it is always shortened (step 1).
      fields.push({ label: `metadata ${key}`, text: shorten(compact(value)) });
    }
  }
  for (const column of ["git_source_file", "git_source_line", "git_source_function"] as const) {
    if (present(row[column]))
      fields.push({ label: column.replace(/_/g, " "), text: String(row[column]) });
  }
  return { header: parts.join(" · "), fields };
}

function render(
  preamble: string,
  blocks: SpanBlock[],
  shortenField: (field: Field) => boolean,
  keep: number,
): { text: string; shortened: number } {
  let shortened = 0;
  const out = [preamble];
  for (const block of blocks) {
    out.push("", block.header);
    for (const field of block.fields) {
      let text = field.text;
      if (shortenField(field)) {
        const cut = shorten(text, keep);
        if (cut !== text) shortened++;
        text = cut;
      }
      out.push(text.includes("\n") ? `${field.label}:\n${text}` : `${field.label}: ${text}`);
    }
  }
  return { text: out.join("\n"), shortened };
}

/** Number the lines, then keep an even sample of them under `budget`, as PostHog does. */
export function sampleLines(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const lines = text.split("\n");
  const width = String(lines.length).length;
  const numbered = lines.map((line, i) => `L${String(i + 1).padStart(width, "0")}: ${line}`);
  const head = numbered.slice(0, PRESERVE_HEADER_LINES);
  const body = numbered.slice(PRESERVE_HEADER_LINES);
  const total = numbered.length;
  const note = (pct: number) =>
    `[SAMPLED VIEW: Showing ~${pct.toFixed(0)}% of ${total.toLocaleString("en-US")} lines. Gaps in line numbers indicate omitted content.]`;
  if (body.length === 0) return numbered.join("\n").slice(0, budget);

  const sample = (target: number) => {
    const step = body.length / target;
    const kept: string[] = [];
    for (let i = 0; i < target; i++) kept.push(body[Math.floor(i * step)]);
    return [...head, note((kept.length / body.length) * 100), ...kept].join("\n");
  };
  const fixed = head.join("\n").length + note(100).length + 2;
  const average = body.reduce((sum, line) => sum + line.length + 1, 0) / body.length;
  let target = Math.max(1, Math.min(body.length, Math.floor((budget - fixed) / average)));
  let result = sample(target);
  for (let i = 0; i < SAMPLING_MAX_ITERATIONS && result.length > budget && target > 1; i++) {
    target = Math.max(1, Math.floor((target * budget * SAMPLING_REDUCTION_FACTOR) / result.length));
    result = sample(target);
  }
  return result.slice(0, budget);
}

export function buildJudgeInput(
  traceId: string,
  spansJsonl: string,
  opts?: { budgetChars?: number },
): JudgeInput {
  const budget = opts?.budgetChars ?? JUDGE_INPUT_BUDGET_CHARS;
  const rows: Record<string, unknown>[] = [];
  let skippedLines = 0;
  for (const line of spansJsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (isObject(row)) rows.push(row);
      else skippedLines++;
    } catch {
      skippedLines++;
    }
  }

  const indexById = new Map<string, number>();
  rows.forEach((row, i) => {
    if (typeof row.span_id === "string") indexById.set(row.span_id, i + 1);
  });
  const counters = { droppedMetadataValues: 0 };
  const blocks = rows.map((row, i) => buildBlock(row, i + 1, indexById, counters));
  const preamble = `TRACE ${traceId} · ${rows.length} spans, in start order`;

  const stats = (pass: number, keep: number, text: string, shortened: number): JudgeInput => ({
    text,
    stats: {
      span_count: rows.length,
      skipped_lines: skippedLines,
      pass,
      keep_chars: keep,
      dropped_metadata_values: counters.droppedMetadataValues,
      shortened_texts: shortened,
      raw_chars: spansJsonl.length,
      final_chars: text.length,
    },
  });

  const whole = render(preamble, blocks, () => false, 0);
  if (whole.text.length <= budget) return stats(1, 0, whole.text, 0);

  // Longest text that a pass may shorten bounds the search for the keep length.
  const longest = Math.max(0, ...blocks.flatMap((b) => b.fields.map((f) => f.text.length)));
  const tryPass = (pass: number, shortenField: (field: Field) => boolean) => {
    const at = (keep: number) => render(preamble, blocks, shortenField, keep);
    if (at(SHORTEN_KEEP_CHARS).text.length > budget) return null;
    let low = SHORTEN_KEEP_CHARS;
    let high = Math.max(low, Math.ceil(longest / 2));
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (at(mid).text.length <= budget) low = mid;
      else high = mid - 1;
    }
    const best = at(low);
    return stats(pass, low, best.text, best.shortened);
  };

  return (
    tryPass(2, (field) => !field.llmOutput) ??
    tryPass(3, () => true) ??
    (() => {
      const all = render(preamble, blocks, () => true, SHORTEN_KEEP_CHARS);
      return stats(4, SHORTEN_KEEP_CHARS, sampleLines(all.text, budget), all.shortened);
    })()
  );
}
