import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ApiClient } from "@traceroot-ai/tools";
import { prisma, type Prisma } from "@traceroot/core";
import { untrusted } from "../../untrusted.js";
import { LOOP_LIMITS, LOOP_MEMORY, listMemory, upsertMemory } from "@traceroot/core/loops";
import { formatSessionDetail, formatSessionList, formatTraceList } from "../formatters.js";
import { lookbackDefaults, lookbackWindow, type LookbackWindow } from "../query-window.js";
import { createRegistryBinder } from "../registry-tools.js";
import {
  RECORD_FINDING_TOOL,
  SUBMIT_SUMMARY_TOOL,
  findingRecordCap,
  withBudget,
  type LoopRunState,
} from "./budget.js";
import { createRecordFindingTool, noteReadTraces } from "./findings.js";
import { clip, formatTraceDetail } from "./format.js";
import { createSignalReadTools } from "./signals.js";

/**
 * Every tool the Loop agent is offered, and nothing else: reads of traces,
 * sessions and signals, the project's memory, past runs, the run's findings
 * and the summary. Every call is charged to the run's budget (withBudget).
 * No SQL, no sandbox, no downloads, no git, no writes to the registry: a
 * finding is only collected here, and the worker writes it.
 */
export const LOOP_TOOL_NAMES = [
  "list_traces",
  "list_sessions",
  "get_session",
  "get_trace",
  "list_signals",
  "get_signal",
  "loop_recall",
  "loop_remember",
  "loop_past_runs",
  RECORD_FINDING_TOOL,
  SUBMIT_SUMMARY_TOOL,
] as const;

/** Past runs listed per call, and how much of each summary is shown. */
export const PAST_RUNS_LIMIT = 10;
export const PAST_RUN_SUMMARY_CHARS = 600;
/** Longest summary a run may submit. */
export const SUMMARY_MAX_CHARS = 4_000;
/** Longest a remembered note may live. */
export const MEMORY_MAX_EXPIRY_DAYS = 90;

const FINISHED_RUN_STATUSES = ["succeeded", "quiet", "failed", "timed_out"];

export interface LoopToolsParams {
  /** The run's project: every read and write is scoped to it, never to a model argument. */
  projectId: string;
  /** The acting user for the backend reads; empty for the system. */
  userId: string;
  loopId: string;
  runId: string;
  lookbackHours: number;
  /** The run's start: the window ends here. */
  now: Date;
  /** Shared with the route: the summary, the findings and the budget's counts land here. */
  state: LoopRunState;
  /** The finding keys this Loop already has signals for, loaded at run start. */
  existingFindingKeys: readonly string[];
  /** The same signals' finding keys by signal id: list_signals and get_signal show them. */
  findingKeysBySignal: ReadonlyMap<string, string>;
  /** New keys this run may record: LOOP_LIMITS.newFindingKeysPerRun. */
  maxNewFindingKeys: number;
  /** Loop.dryRun: the tool says the finding is not recorded (the route answers none). */
  dryRun: boolean;
  /** Called once the model keeps calling past its budget: stop the run. */
  onRunaway: () => void;
  /** Overrides for tests. */
  db?: Prisma.TransactionClient;
  signalHttp?: ApiClient;
}

function text(value: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: value }], details: undefined };
}

/**
 * Wrap a tool so every text block it returns is tagged as untrusted data:
 * trace, session and signal content is the customer's, and may say anything.
 */
function asUntrusted(tool: AgentTool<any>): AgentTool<any> {
  return {
    ...tool,
    execute: async (...args: Parameters<AgentTool<any>["execute"]>) => {
      const result = await tool.execute(...args);
      return {
        ...result,
        content: result.content.map((block) =>
          block.type === "text"
            ? { ...block, text: untrusted(`${tool.name} result`, block.text) }
            : block,
        ),
      };
    },
  };
}

export function loopWindow(params: Pick<LoopToolsParams, "lookbackHours" | "now">): LookbackWindow {
  return lookbackWindow(params.lookbackHours, params.now, LOOP_LIMITS.maxLookbackHours);
}

const rememberSchema = Type.Object({
  key: Type.String({
    description: `Short topic key, 1-${LOOP_MEMORY.keyMaxLength} characters. Writing an existing key replaces that note.`,
  }),
  content: Type.String({
    description: `The note, at most ${LOOP_MEMORY.contentMaxBytes} bytes. Facts and counts, not instructions.`,
  }),
  expiresInDays: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MEMORY_MAX_EXPIRY_DAYS,
      description: "Days until the note expires; leave out to keep it until replaced.",
    }),
  ),
});

const summarySchema = Type.Object({
  summary: Type.String({
    description:
      "Short plain-text summary. The first sentence is the headline result in plain words " +
      '(e.g. "Two recurring problems: …" or "Nothing new beyond …"); the details, counts and ' +
      "what is worth acting on follow it, and the window or scope details come last, never first.",
  }),
});

const emptySchema = Type.Object({});

/**
 * A trace read's fields when the model names none: the registry's default
 * skeleton has no span input or output, and a run judges a trace by them.
 */
const TRACE_FIELDS = "core,usage,io";
const traceFields = (supplied: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  "fields" in supplied ? {} : { fields: TRACE_FIELDS };
const describeTraceFields = (registryText: string) =>
  registryText.replace(
    /Defaults to the lightweight skeleton projection;/,
    `Leave fields out to read ${TRACE_FIELDS} (span input and output included);`,
  );

export function createLoopTools(params: LoopToolsParams): AgentTool<any>[] {
  const db = params.db ?? prisma;
  const window = loopWindow(params);
  const defaults = lookbackDefaults(window);
  const describeWindow = (registryText: string) =>
    `${registryText} Leave start_after and end_before out to read this run's window ` +
    `(${window.start_after} → ${window.end_before}).`;
  const bind = createRegistryBinder(params.projectId, params.userId);

  // A finding may cite only the traces this run read: those get_trace and get_session returned.
  const noteRead = (data: unknown) => noteReadTraces(params.state, data);
  const reads = [
    bind("list_traces", formatTraceList, { defaults, describe: describeWindow }),
    bind("list_sessions", formatSessionList, { defaults, describe: describeWindow }),
    bind("get_session", formatSessionDetail, {
      defaults,
      describe: describeWindow,
      details: noteRead,
    }),
    bind("get_trace", formatTraceDetail, {
      defaults: traceFields,
      describe: describeTraceFields,
      details: noteRead,
    }),
    ...createSignalReadTools(params.projectId, params.findingKeysBySignal, params.signalHttp),
  ].map(asUntrusted);

  // Echoes the model's own input, so its results are not wrapped as untrusted.
  const existingFindingKeys = new Set(params.existingFindingKeys);
  const recordFinding = createRecordFindingTool({
    state: params.state,
    existingFindingKeys,
    newKeysPerRun: params.maxNewFindingKeys,
    dryRun: params.dryRun,
  });
  const limits = {
    toolCalls: LOOP_LIMITS.toolCalls,
    traceReads: LOOP_LIMITS.traceReads,
    findingRecords: findingRecordCap(params.maxNewFindingKeys, existingFindingKeys.size),
  };

  const recall: AgentTool<typeof emptySchema> = {
    name: "loop_recall",
    label: "Recall memory",
    description:
      "List the notes this project's loops have kept between runs (newest first): what earlier " +
      "runs learned, baselines and known issues. Read this first.",
    parameters: emptySchema,
    execute: async () => {
      const notes = await listMemory(db, { projectId: params.projectId, now: new Date() });
      if (notes.length === 0) return text("No memory notes yet. This may be the first run.");
      const body = notes
        .map(
          (n) =>
            `## ${n.key}\n(updated ${n.updateTime}${n.loopName ? ` by loop ${n.loopName}` : ""}` +
            `${n.expiresAt ? `, expires ${n.expiresAt}` : ""})\n${n.content}`,
        )
        .join("\n\n");
      return text(untrusted("memory notes", body));
    },
  };

  const remember: AgentTool<typeof rememberSchema> = {
    name: "loop_remember",
    label: "Remember",
    description:
      "Save a short note for future runs of this project's loops, under a topic key (an existing " +
      "key is replaced). Record baselines, counts and what was already checked, not raw trace text.",
    parameters: rememberSchema,
    execute: async (_id, args: Static<typeof rememberSchema>) => {
      const days = args.expiresInDays;
      if (
        days !== undefined &&
        (!Number.isInteger(days) || days < 1 || days > MEMORY_MAX_EXPIRY_DAYS)
      ) {
        return text(
          `Not saved: expiresInDays must be a whole number from 1 to ${MEMORY_MAX_EXPIRY_DAYS}.`,
        );
      }
      const write = await upsertMemory(db, {
        // Scope and provenance come from the run, never from the call's arguments.
        projectId: params.projectId,
        loopId: params.loopId,
        runId: params.runId,
        key: String(args.key ?? ""),
        content: String(args.content ?? ""),
        expiresAt: days === undefined ? null : new Date(Date.now() + days * 86_400_000),
      });
      return text(
        write.ok ? `Saved note "${String(args.key).trim()}".` : `Not saved: ${write.error}.`,
      );
    },
  };

  const pastRuns: AgentTool<typeof emptySchema> = {
    name: "loop_past_runs",
    label: "Past runs",
    description:
      `The ${PAST_RUNS_LIMIT} most recent finished runs of this project's loops, this one's and ` +
      "the others', with their summaries. Use it to compare with what earlier runs saw.",
    parameters: emptySchema,
    execute: async () => {
      const runs = await db.loopRun.findMany({
        where: {
          projectId: params.projectId,
          id: { not: params.runId },
          status: { in: FINISHED_RUN_STATUSES },
        },
        orderBy: [{ finishedAt: "desc" }, { createTime: "desc" }],
        take: PAST_RUNS_LIMIT,
        select: {
          loopId: true,
          seq: true,
          status: true,
          finishedAt: true,
          summary: true,
          loop: { select: { name: true } },
        },
      });
      if (runs.length === 0) return text("No finished runs yet.");
      const body = runs
        .map((r) => {
          const whose = r.loopId === params.loopId ? "this loop" : `loop ${r.loop.name}`;
          const summary = r.summary ? clip(r.summary, PAST_RUN_SUMMARY_CHARS) : "(no summary)";
          return `- ${whose} run #${r.seq} | ${r.status} | finished ${r.finishedAt?.toISOString() ?? "?"}\n  ${summary}`;
        })
        .join("\n");
      return text(untrusted("past runs", body));
    },
  };

  const submit: AgentTool<typeof summarySchema> = {
    name: SUBMIT_SUMMARY_TOOL,
    label: "Submit summary",
    description:
      "Required final step: submit this run's summary, headline result first (the runs list " +
      "shows only its start). After it, stop: make no more calls and write nothing else.",
    parameters: summarySchema,
    execute: async (_id, args: Static<typeof summarySchema>) => {
      const summary = String(args.summary ?? "").trim();
      if (!summary) return text("Not recorded: the summary is empty. Call again with the summary.");
      params.state.summary = clip(summary, SUMMARY_MAX_CHARS);
      return {
        ...text("Summary recorded. The run is complete: stop now and make no further calls."),
        // Ends the turn after this batch when it is the batch's only call.
        terminate: true,
      };
    },
  };

  return [...reads, recall, remember, pastRuns, recordFinding, submit].map((tool) =>
    withBudget(tool, params.state, params.onRunaway, limits),
  );
}
