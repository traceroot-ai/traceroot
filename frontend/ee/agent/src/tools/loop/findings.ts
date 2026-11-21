/**
 * Findings a Loop run collects. The agent service only collects them: the
 * worker turns each into a hit of the Loop's hidden detector, and the signals
 * pipeline groups it under `loop:<key>`.
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  LOOP_FINDING_KEY_PATTERN,
  LOOP_FINDING_TEXT_MAX,
  LOOP_LIMITS,
  type LoopFinding,
} from "@traceroot/core/loops/pure";
import { RECORD_FINDING_TOOL, SUBMIT_SUMMARY_TOOL, type LoopRunState } from "./budget.js";

export const DRY_RUN_FINDING_REPLY =
  "Dry run: this finding is not recorded. Mention it in your summary.";

/**
 * The trace ids a get_trace or get_session answer returned: the traces this run
 * read. A finding cites only these, never an id it only saw in a list.
 */
export function readTraceIds(data: unknown): string[] {
  const body = (data ?? {}) as { trace_id?: unknown; traces?: unknown };
  const ids = [body.trace_id];
  if (Array.isArray(body.traces)) {
    for (const trace of body.traces) ids.push((trace as { trace_id?: unknown } | null)?.trace_id);
  }
  return ids.filter((id): id is string => typeof id === "string" && id !== "");
}

/** Note the traces a successful get_trace / get_session call returned, as that call's details. */
export function noteReadTraces(state: LoopRunState, data: unknown): { readTraceIds: string[] } {
  const ids = readTraceIds(data);
  for (const id of ids) state.readTraceIds.add(id);
  return { readTraceIds: ids };
}

/** Plain text: no HTML tags, no links (a markdown link keeps its label), trimmed. */
export function plainFindingText(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

const recordFindingSchema = Type.Object({
  key: Type.String({
    description:
      "Stable kebab-case id of the problem, 2-63 characters of a-z, 0-9 and -, e.g. " +
      '"checkout-payment-timeouts". Reuse this loop\'s existing key when it is the same problem.',
  }),
  title: Type.String({
    description: `What the problem is, in plain words; at most ${LOOP_FINDING_TEXT_MAX.title} characters.`,
  }),
  covers: Type.String({
    description: `What the problem includes, one or two sentences; at most ${LOOP_FINDING_TEXT_MAX.covers} characters.`,
  }),
  summary: Type.String({
    description: `The evidence, with counts (e.g. "14 of 220 traces …"); at most ${LOOP_FINDING_TEXT_MAX.summary} characters.`,
  }),
  traceIds: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: LOOP_LIMITS.tracesPerFinding,
    description: `1-${LOOP_LIMITS.tracesPerFinding} ids of traces that show the problem, each one you read this run with get_trace or get_session.`,
  }),
});

export interface RecordFindingParams {
  state: LoopRunState;
  /** The finding keys this Loop already has a signal for: reusing one is not a new key. */
  existingFindingKeys: ReadonlySet<string>;
  /** How many keys this run may add beyond the existing ones. */
  newKeysPerRun: number;
  dryRun: boolean;
}

function text(value: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: value }], details: undefined };
}

function notRecorded(reason: string): AgentToolResult<undefined> {
  return text(`Not recorded: ${reason}`);
}

function boundedText(
  name: string,
  raw: unknown,
  max: number,
): { value: string } | { error: string } {
  const value = plainFindingText(raw);
  if (!value) return { error: `${name} must be non-empty plain text.` };
  if (value.length > max) {
    return { error: `${name} is ${value.length} characters; at most ${max} are allowed.` };
  }
  return { value };
}

export function createRecordFindingTool(
  params: RecordFindingParams,
): AgentTool<typeof recordFindingSchema> {
  const { state, existingFindingKeys, newKeysPerRun, dryRun } = params;
  return {
    name: RECORD_FINDING_TOOL,
    label: "Record finding",
    description:
      "Record a recurring problem this run confirmed, so it becomes (or adds to) this loop's " +
      `signal. At most ${LOOP_LIMITS.findingsPerRun} findings per run, of them at most ` +
      `${newKeysPerRun} new keys; the others reuse existing keys of this loop. ` +
      "Recording a key again in this run merges its traces and keeps the " +
      `latest text. Call it before ${SUBMIT_SUMMARY_TOOL}.`,
    parameters: recordFindingSchema,
    execute: async (_id, args: Static<typeof recordFindingSchema>) => {
      const key = String(args.key ?? "").trim();
      if (!LOOP_FINDING_KEY_PATTERN.test(key)) {
        return notRecorded(
          `key ${JSON.stringify(key)} must be kebab-case: 2-63 characters of a-z, 0-9 and -, starting with a letter or digit.`,
        );
      }
      const fields: Record<"title" | "covers" | "summary", string> = {
        title: "",
        covers: "",
        summary: "",
      };
      for (const name of ["title", "covers", "summary"] as const) {
        const checked = boundedText(name, args[name], LOOP_FINDING_TEXT_MAX[name]);
        if ("error" in checked) return notRecorded(checked.error);
        fields[name] = checked.value;
      }

      if (!Array.isArray(args.traceIds) || args.traceIds.length === 0) {
        return notRecorded("traceIds must list at least one trace id.");
      }
      const traceIds = [...new Set(args.traceIds.map((id) => String(id ?? "").trim()))].filter(
        Boolean,
      );
      if (traceIds.length === 0) return notRecorded("traceIds must list at least one trace id.");
      if (traceIds.length > LOOP_LIMITS.tracesPerFinding) {
        return notRecorded(
          `traceIds lists ${traceIds.length} traces; at most ${LOOP_LIMITS.tracesPerFinding} are allowed.`,
        );
      }
      const unread = traceIds.filter((id) => !state.readTraceIds.has(id));
      if (unread.length > 0) {
        return notRecorded(
          `these traces were not read this run: ${unread.join(", ")}. ` +
            "Cite only traces you opened with get_trace or get_session.",
        );
      }

      const previous = state.findings.get(key);
      if (!previous && state.findings.size >= LOOP_LIMITS.findingsPerRun) {
        return notRecorded(
          `this run already recorded ${state.findings.size} findings, the most allowed. ` +
            "Add traces to one of those, or mention the problem in the summary.",
        );
      }
      if (!previous && !existingFindingKeys.has(key)) {
        const newKeys = [...state.findings.keys()].filter((k) => !existingFindingKeys.has(k));
        if (newKeys.length >= newKeysPerRun) {
          return notRecorded(
            `this run already recorded ${newKeys.length} new keys (${newKeys.join(", ")}), the most ` +
              `allowed. Reuse one of those or an existing key of this loop, or mention the problem in the summary.`,
          );
        }
      }
      const merged = previous ? [...new Set([...previous.traceIds, ...traceIds])] : traceIds;
      if (merged.length > LOOP_LIMITS.tracesPerFinding) {
        return notRecorded(
          `"${key}" would hold ${merged.length} traces with the ones already recorded this run; ` +
            `at most ${LOOP_LIMITS.tracesPerFinding} are allowed.`,
        );
      }
      const finding: LoopFinding = { key, ...fields, traceIds: merged };
      // A dry run keeps the finding too, so its later calls meet the same caps;
      // the route answers no findings for it.
      state.findings.set(key, finding);
      if (dryRun) return text(DRY_RUN_FINDING_REPLY);
      const kind = previous
        ? "updated"
        : existingFindingKeys.has(key)
          ? "recorded (existing key)"
          : "recorded (new key)";
      return text(`Finding "${key}" ${kind} with ${merged.length} traces.`);
    },
  };
}
