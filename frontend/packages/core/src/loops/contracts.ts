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
 * The rows of a Loop turn in which the agent replied: a tool call, or assistant
 * text. A model that fails before answering leaves only the kickoff and an
 * empty assistant row that carries the error. The plan counts a run from these.
 */
export const LOOP_REPLIED_MESSAGE_WHERE = [
  { role: "tool_step" },
  { role: "assistant", content: { not: "" } },
];

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
export interface LoopRunModel {
  model: string;
  provider: string;
  source: "system" | "byok";
}

/** The agent service's answer to one Loop run. */
export interface LoopAgentResult {
  status: LoopAgentOutcome;
  summary: string | null;
  tracesRead: number;
  toolCalls: number;
  costUsd: number | null;
  error: string | null;
  /** Null when the turn never started. */
  modelUsed: LoopRunModel | null;
}

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
