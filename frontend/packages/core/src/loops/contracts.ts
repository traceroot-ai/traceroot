/**
 * The Loop contracts: limits, status vocabularies, input schemas and the JSON
 * shapes the routes answer with. Pure: no database, safe in the browser.
 */
import { z } from "zod";
import { LOOP_TEMPLATE_IDS } from "./templates.ts";
import { loopScheduleSchema, type LoopSchedule } from "./schedule.ts";

export const LOOP_LIMITS = {
  loopsPerProject: 5,
  runsPerProjectPerDay: 24,
  runTimeoutMinutes: 20,
  toolCalls: 80,
  traceReads: 25,
  newFindingKeysPerRun: 2,
  findingsPerRun: 5,
  tracesPerFinding: 20,
  failureStreakToPause: 5,
  nameMaxLength: 80,
  instructionsMaxLength: 8_000,
  maxLookbackHours: 168,
} as const;

/** "paused_by_system": paused after LOOP_LIMITS.failureStreakToPause failed scheduled runs in a row. */
export const LOOP_STATUSES = ["active", "paused", "paused_by_system"] as const;
export type LoopStatus = (typeof LOOP_STATUSES)[number];

export const LOOP_RUN_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "quiet",
  "failed",
  "timed_out",
  "skipped_blocked",
  "skipped_paused",
  "skipped_no_traces",
] as const;
export type LoopRunStatus = (typeof LOOP_RUN_STATUSES)[number];

export const LOOP_RUN_TRIGGERS = ["schedule", "manual"] as const;
export type LoopRunTrigger = (typeof LOOP_RUN_TRIGGERS)[number];

/** A run in one of these is still going: a Loop never has two. */
export const ACTIVE_RUN_STATUSES: readonly LoopRunStatus[] = ["pending", "running"];

/**
 * The statuses of a run that started: a plan-limit skip or a paused-loop skip
 * never did, and a pending run has not yet. An empty window's skip
 * (skipped_no_traces) started but never called the agent.
 */
export const COUNTED_RUN_STATUSES: readonly LoopRunStatus[] = [
  "running",
  "succeeded",
  "quiet",
  "failed",
  "timed_out",
];

/**
 * The loop_runs filter for runs that count against the project's daily cap:
 * runs that called the agent. (The plan's meter counts runs from their Loop
 * turns in ai_messages, which outlive a deleted Loop, and only those in which
 * the agent replied.) The worker gives a run its session just before
 * that call, so a run that failed before it (its BYOK provider is gone) has
 * none and does not count.
 */
export const COUNTED_RUN_WHERE = {
  status: { in: [...COUNTED_RUN_STATUSES] },
  sessionId: { not: null },
};

export const LOOP_MEMORY = { keyMaxLength: 200, contentMaxBytes: 8 * 1024 } as const;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const name = z
  .string("name must be a non-empty string")
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1, "name must be a non-empty string")
      .max(
        LOOP_LIMITS.nameMaxLength,
        `name must be at most ${LOOP_LIMITS.nameMaxLength} characters`,
      ),
  );

const modelFields = {
  source: z
    .union([z.literal("system"), z.literal("byok"), z.null()], 'source must be "system" or "byok"')
    .optional(),
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
};

const lookbackRange = `lookbackHours must be between 1 and ${LOOP_LIMITS.maxLookbackHours}`;

const loopFields = {
  template: z
    .enum(LOOP_TEMPLATE_IDS, "template is not a known loop template")
    .nullable()
    .optional(),
  schedule: loopScheduleSchema,
  dryRun: z.boolean("dryRun must be a boolean").optional(),
  lookbackHours: z
    .number("lookbackHours must be a whole number")
    .int("lookbackHours must be a whole number")
    .min(1, lookbackRange)
    .max(LOOP_LIMITS.maxLookbackHours, lookbackRange)
    .optional(),
  ...modelFields,
};

/**
 * `instructions` is the whole prompt a run works from: a template only
 * pre-fills it, so every Loop needs some, templated or not.
 */
export const LOOP_INSTRUCTIONS_REQUIRED =
  "Every loop needs instructions: they are the prompt each run follows.";

/** Why a create or rename is refused: another Loop has the name. The form shows it under Name. */
export const LOOP_NAME_TAKEN = "A loop with this name already exists";
/** Why a create or rename is refused: a user detector already has the Loop's detector name. */
export const LOOP_NAME_TAKEN_BY_DETECTOR =
  'A detector already has this name with the "loop:" prefix; rename that detector to use this name';

/** Why "Run now" is refused; the button shows the same reason while it is disabled. */
export const LOOP_RUN_IN_PROGRESS = "This loop already has a run in progress";
export const LOOP_RUN_PAUSED = "Resume this loop to run it.";
export const LOOP_RUN_PLAN_BLOCKED =
  "This workspace has used its plan's loop runs. Upgrade to run this loop.";

const instructions = z
  .string({
    error: (issue) =>
      issue.input === undefined ? LOOP_INSTRUCTIONS_REQUIRED : "instructions must be text",
  })
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1, LOOP_INSTRUCTIONS_REQUIRED)
      .max(
        LOOP_LIMITS.instructionsMaxLength,
        `instructions must be at most ${LOOP_LIMITS.instructionsMaxLength} characters`,
      ),
  );

export const createLoopSchema = z.object({ name, instructions, ...loopFields });
export type CreateLoopInput = z.input<typeof createLoopSchema>;

/** PATCH: every field optional; a field left out is untouched, but a sent one may not be blank. */
export const updateLoopSchema = z.object({ name, instructions, ...loopFields }).partial();
export type UpdateLoopInput = z.input<typeof updateLoopSchema>;

export const loopStatusActionSchema = z.object({
  action: z.enum(["pause", "resume"], 'action must be "pause" or "resume"'),
});

// ---------------------------------------------------------------------------
// Findings: agent service → worker → signals round
// ---------------------------------------------------------------------------

/**
 * A finding key: the stable kebab-case id of a recurring problem, its signal's "loop:<key>".
 * 2-63 characters of a-z and 0-9 in words joined by single hyphens (no leading, trailing or
 * repeated hyphen).
 */
export const LOOP_FINDING_KEY_PATTERN = /^(?=.{2,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LOOP_FINDING_TEXT_MAX = { title: 120, covers: 500, summary: 1_000 } as const;

const findingKey = z.string().regex(LOOP_FINDING_KEY_PATTERN);
const findingTitle = z.string().min(1).max(LOOP_FINDING_TEXT_MAX.title);
const findingCovers = z.string().min(1).max(LOOP_FINDING_TEXT_MAX.covers);

/** A recurring problem a run recorded; the worker writes one hit per trace. */
export const loopFindingSchema = z.object({
  key: findingKey,
  title: findingTitle,
  covers: findingCovers,
  summary: z.string().min(1).max(LOOP_FINDING_TEXT_MAX.summary),
  traceIds: z.array(z.string().min(1)).min(1).max(LOOP_LIMITS.tracesPerFinding),
});
export type LoopFinding = z.infer<typeof loopFindingSchema>;

/** A Loop hit's `data`: the signals round groups the hit and titles its signal by it. */
export const loopHitDataSchema = z.object({
  loopFindingKey: findingKey,
  title: findingTitle,
  covers: findingCovers,
});
export type LoopHitData = z.infer<typeof loopHitDataSchema>;

export const LOOP_AGENT_OUTCOMES = [
  "submitted",
  "no_summary",
  "budget_exhausted",
  "timed_out",
  "error",
] as const;
export type LoopAgentOutcome = (typeof LOOP_AGENT_OUTCOMES)[number];

/**
 * The model a Loop run's turn ran on, as the agent built it: the run's own
 * choice, or the agent service's default when the run named none. `provider`
 * is a BYOK model's saved provider label, else the model's provider.
 */
export const loopRunModelSchema = z.object({
  model: z.string(),
  provider: z.string(),
  source: z.enum(["system", "byok"]),
});
export type LoopRunModel = z.infer<typeof loopRunModelSchema>;

/**
 * One of a Loop's signals as its next run sees it: the problem behind a finding
 * key and what people decided about it.
 */
export interface ExistingLoopSignal {
  key: string;
  signalId: string;
  title: string;
  /** SIGNAL_STATUSES: "open" | "resolved" | "dismissed". */
  status: string;
  /** RESOLVE_REASONS / DISMISS_REASONS code behind the current resolved or dismissed status. */
  reason: string | null;
  /** The note given with that reason; written by a person, so untrusted. */
  note: string | null;
  /** Set when people merged this signal into another: its hits land there. */
  mergedIntoId: string | null;
}

/** The agent service's answer to one Loop run; the worker validates it. */
export const loopAgentResultSchema = z.object({
  status: z.enum(LOOP_AGENT_OUTCOMES),
  summary: z.string().nullable(),
  tracesRead: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  costUsd: z.number().nullable(),
  error: z.string().nullable(),
  /** Null when the turn never started. */
  modelUsed: loopRunModelSchema.nullable(),
  /** Empty when the run recorded none, and on a dry run. */
  findings: z.array(loopFindingSchema).max(LOOP_LIMITS.findingsPerRun),
});
export type LoopAgentResult = z.infer<typeof loopAgentResultSchema>;

// ---------------------------------------------------------------------------
// Responses (dates as ISO strings)
// ---------------------------------------------------------------------------

export interface LoopRunDto {
  id: string;
  loopId: string;
  seq: number;
  trigger: LoopRunTrigger;
  slotAt: string | null;
  status: LoopRunStatus;
  attempts: number;
  sessionId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  summary: string | null;
  findingKeys: string[];
  tracesRead: number;
  error: string | null;
  metadata: Record<string, unknown> | null;
  costUsd: number | null;
  createTime: string;
}

export interface LoopDto {
  id: string;
  projectId: string;
  /** The Loop's hidden detector: signals it creates carry this detectorId. */
  detectorId: string;
  name: string;
  template: string | null;
  instructions: string;
  schedule: LoopSchedule;
  status: LoopStatus;
  dryRun: boolean;
  model: string | null;
  provider: string | null;
  source: "system" | "byok" | null;
  lookbackHours: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  failureStreak: number;
  createdBy: string;
  createTime: string;
  updateTime: string;
}

/** A Loop as the list and detail pages show it: the row plus its roll-ups. */
export interface LoopSummaryDto extends LoopDto {
  lastRun: LoopRunDto | null;
  /** Runs that called the agent. */
  runCount: number;
  /** Mean cost of those runs; null before the first one. */
  avgCostUsd: number | null;
  /** Signals the Loop created (its hidden detector's signals). */
  signalCount: number;
}

export interface LoopMemoryDto {
  id: string;
  /**
   * The Loop that last wrote the note; null = writer unknown (that Loop was
   * deleted, or the note was seeded). Every note is shared by the project's Loops.
   */
  loopId: string | null;
  /** That Loop's current name; null exactly when `loopId` is. */
  loopName: string | null;
  key: string;
  content: string;
  expiresAt: string | null;
  expired: boolean;
  updatedByRunId: string | null;
  updateTime: string;
}

export interface Paged<T> {
  data: T[];
  meta: { page: number; limit: number; total: number };
}
