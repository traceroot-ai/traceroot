/**
 * Renders a trace's spans.jsonl (one ClickHouse `spans` row per line) as the
 * plain text an LLM detector judge reads.
 *
 * Step 1 slims every span: only the columns that describe what happened are
 * kept, metadata values that repeat the span's input or output are dropped
 * (as are the Vercel AI SDK copies under known keys, unless the column they
 * copy is empty: then the copy stands in for it), and long metadata values
 * keep only their head and tail. A span whose input or output is the same text
 * as a direct child's shows it once, in the child; the span keeps a marker.
 *
 * Step 2 fits the text into the budget in passes: render everything; else
 * shorten every long text to its head and tail but keep LLM outputs whole;
 * else shorten LLM outputs too; else number the lines and keep an even sample
 * of them. A pass keeps as much of each head and tail as the budget allows
 * (SHORTEN_KEEP_CHARS at least), so a trace just over the budget loses
 * little. Every span keeps a place in the text, and each cut leaves a marker
 * the system prompt explains.
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

/** Vercel AI SDK attributes that hold copies of the span's input or output, and which one. */
const SDK_COPY_KEYS = new Map<string, "input" | "output">([
  ["ai.prompt", "input"],
  ["ai.prompt.messages", "input"],
  ["ai.response.text", "output"],
  ["ai.response.object", "output"],
  ["ai.response.toolCalls", "output"],
  ["ai.toolCall.args", "input"],
  ["ai.toolCall.result", "output"],
]);
/** Which input copy stands in for an empty input column, most structured first. */
const INPUT_COPY_PREFERENCE = ["ai.prompt.messages", "ai.toolCall.args", "ai.prompt"];
/** Keys of the Vercel AI SDK prompt object (ai.generateText's input), in reading order. */
const PROMPT_KEYS = ["system", "prompt", "messages"];
/** A parent's text and its child's count as the same when the shorter is this share of the longer. */
const SAME_TEXT_MIN_RATIO = 0.9;

/** Explains the text format and its markers; appended to the judge's system prompt. */
export const JUDGE_INPUT_FORMAT_NOTE = `TRACE FORMAT:
- Each span starts with "[n]", its number in start order; "parent [m]" names the span that contains it.
- "(same as input of [n])" (or output) means this span's input is the same text as span [n]'s, shown there once; any text after "plus:" is what this span has that [n] lacks.
- To fit the trace into your context, the monitoring system may shorten long texts. "... (N chars truncated) ..." marks text the monitoring system removed, not the agent. A "[SAMPLED VIEW ...]" line means only some lines are shown; gaps in the line numbers are omitted lines.
- Never report removed or omitted text as a problem in the trace. Judge only what is shown.`;

/** One piece of text that a pass may shorten. */
interface Field {
  label: string;
  text: string;
  /** LLM outputs survive pass 2 whole. */
  llmOutput?: boolean;
  /** Set on the fields that show the span's input or output. */
  of?: Side;
}

type Side = "input" | "output";

interface SpanBlock {
  header: string;
  fields: Field[];
  parent?: number;
  /** Plain text of the input and output, whitespace-normalized, for spotting repeats. */
  texts: Partial<Record<Side, string>>;
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
    /** Inputs and outputs replaced by a "(same as ... of [n])" marker. */
    collapsed_fields: number;
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

/** The text a value shows, without JSON shape, so a prompt object and a messages array compare. */
function plainText(value: JsonValue): string {
  if (Array.isArray(value) && value.length > 0 && value.every(isMessage))
    return value.map(messageText).join("\n");
  if (isMessage(value)) return messageText(value);
  const keys = isObject(value) ? Object.keys(value) : [];
  if (isObject(value) && keys.length > 0 && keys.every((k) => PROMPT_KEYS.includes(k))) {
    return PROMPT_KEYS.filter((k) => value[k] !== undefined && value[k] !== null)
      .map((k) => plainText(value[k]))
      .join("\n");
  }
  return compact(value);
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
  const sides: Record<Side, JsonValue[]> = { input: [], output: [] };
  const add = (of: Side, value: JsonValue, label: string, llmOutput: boolean) => {
    sides[of].push(value);
    fields.push(...valueFields(label, value, llmOutput).map((f) => ({ ...f, of })));
  };
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
  const llmOutput = kind === "LLM";
  if (input !== undefined) add("input", input, "input", false);
  if (output !== undefined) add("output", output, "output", llmOutput);

  const copies = new Set([input, output].filter((v) => v !== undefined).map((v) => canonical(v!)));
  const metadata = typeof row.metadata === "string" ? parseJsonString(row.metadata) : row.metadata;
  if (isObject(metadata)) {
    // ai.prompt.messages and ai.prompt hold the same prompt, so one copy stands in for the input.
    const inputCopy =
      input === undefined
        ? INPUT_COPY_PREFERENCE.find(
            (k) => metadata[k] !== undefined && metadata[k] !== null && metadata[k] !== "",
          )
        : undefined;
    for (const [key, raw] of Object.entries(metadata)) {
      if (raw === null || raw === "") continue;
      const value = parseDeep(raw);
      const copyOf = SDK_COPY_KEYS.get(key);
      // A copy whose column is empty stands in for it: kept whole, and shortened like it.
      const standsIn =
        copyOf === "input" ? key === inputCopy : copyOf === "output" && output === undefined;
      if (copyOf && standsIn) {
        add(copyOf, value, `metadata ${key}`, copyOf === "output" && llmOutput);
        continue;
      }
      if (copyOf || copies.has(canonical(value))) {
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
  const texts: SpanBlock["texts"] = {};
  for (const of of ["input", "output"] as const) {
    const text = sides[of].map(plainText).join("\n").replace(/\s+/g, " ").trim();
    if (text) texts[of] = text;
  }
  return { header: parts.join(" · "), fields, parent, texts };
}

/**
 * What of `text` is not in `other` when the two count as the same text (one
 * contains the other and the shorter is SAME_TEXT_MIN_RATIO of the longer);
 * null when they do not.
 */
function leftover(text: string, other: string | undefined): string | null {
  if (!other) return null;
  const [short, long] = text.length <= other.length ? [text, other] : [other, text];
  if (short.length < SAME_TEXT_MIN_RATIO * long.length) return null;
  const at = long.indexOf(short);
  if (at < 0) return null;
  if (long === other) return "";
  return [text.slice(0, at), text.slice(at + short.length)]
    .map((piece) => piece.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Agent frameworks often record the same prompt or answer on a span and on
 * its direct child (ai.generateText and its doGenerate). The child keeps the
 * field; the parent's becomes a marker naming the child, plus any text the
 * child lacks, so no text that is not repeated is dropped. Returns how many
 * fields were collapsed.
 */
function collapseRepeats(blocks: SpanBlock[]): number {
  const children = new Map<number, number[]>();
  blocks.forEach((block, i) => {
    if (block.parent !== undefined)
      children.set(block.parent, [...(children.get(block.parent) ?? []), i + 1]);
  });
  let collapsed = 0;
  blocks.forEach((block, i) => {
    for (const of of ["input", "output"] as const) {
      const text = block.texts[of];
      if (!text) continue;
      for (const child of children.get(i + 1) ?? []) {
        const rest = leftover(text, blocks[child - 1].texts[of]);
        if (rest === null) continue;
        const marker = `(same as ${of} of [${child}])${rest ? ` plus:\n${rest}` : ""}`;
        // A marker no shorter than the text it replaces saves nothing.
        if (marker.length >= text.length) break;
        const at = block.fields.findIndex((f) => f.of === of);
        const kept = block.fields.filter((f) => f.of !== of);
        kept.splice(at, 0, { label: of, text: marker });
        block.fields = kept;
        collapsed++;
        break;
      }
    }
  });
  return collapsed;
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

/** Number the lines, then keep an even sample of them under `budget`. */
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
  const collapsedFields = collapseRepeats(blocks);
  const preamble = `TRACE ${traceId} · ${rows.length} spans, in start order`;

  const stats = (pass: number, keep: number, text: string, shortened: number): JudgeInput => ({
    text,
    stats: {
      span_count: rows.length,
      skipped_lines: skippedLines,
      pass,
      keep_chars: keep,
      dropped_metadata_values: counters.droppedMetadataValues,
      collapsed_fields: collapsedFields,
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
