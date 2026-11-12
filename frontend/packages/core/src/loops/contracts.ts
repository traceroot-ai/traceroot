/**
 * The Loop contracts shared by the route handlers, the write-service, the UI
 * and (later) the worker: limits, status vocabularies, input schemas and the
 * JSON shapes the routes answer with. Pure: no database, safe in the browser.
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
  precheckSqlMaxLength: 4_000,
  maxLookbackHours: 168,
} as const;

export const LOOP_STATUSES = ["active", "paused", "paused_by_system"] as const;
export type LoopStatus = (typeof LOOP_STATUSES)[number];

/** Why the system paused a Loop. Only one reason exists today. */
export const LOOP_PAUSE_REASONS = ["failures"] as const;
export type LoopPauseReason = (typeof LOOP_PAUSE_REASONS)[number];

export const LOOP_RUN_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "quiet",
  "failed",
  "timed_out",
  "skipped_precheck",
  "skipped_blocked",
] as const;
export type LoopRunStatus = (typeof LOOP_RUN_STATUSES)[number];

export const LOOP_RUN_TRIGGERS = ["schedule", "manual"] as const;
export type LoopRunTrigger = (typeof LOOP_RUN_TRIGGERS)[number];

/** A run in one of these is still going: a Loop never has two. */
export const ACTIVE_RUN_STATUSES: readonly LoopRunStatus[] = ["pending", "running"];

/**
 * Runs that called the agent count against the plan; a pre-check skip or a
 * plan-limit skip did not, and a pending run has not yet.
 */
export const COUNTED_RUN_STATUSES: readonly LoopRunStatus[] = [
  "running",
  "succeeded",
  "quiet",
  "failed",
  "timed_out",
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

const loopFields = {
  template: z
    .enum(LOOP_TEMPLATE_IDS, "template is not a known Loop template")
    .nullable()
    .optional(),
  instructions: z
    .string("instructions must be text")
    .max(
      LOOP_LIMITS.instructionsMaxLength,
      `instructions must be at most ${LOOP_LIMITS.instructionsMaxLength} characters`,
    )
    .optional(),
  schedule: loopScheduleSchema,
  dryRun: z.boolean("dryRun must be a boolean").optional(),
  precheckSql: z.string().max(LOOP_LIMITS.precheckSqlMaxLength).nullable().optional(),
  lookbackHours: z
    .number("lookbackHours must be a whole number")
    .int("lookbackHours must be a whole number")
    .min(1, "lookbackHours must be between 1 and 168")
    .max(LOOP_LIMITS.maxLookbackHours, "lookbackHours must be between 1 and 168")
    .optional(),
  maxFindingsPerRun: z
    .number("maxFindingsPerRun must be a whole number")
    .int("maxFindingsPerRun must be a whole number")
    .min(1, "maxFindingsPerRun must be between 1 and 2")
    .max(LOOP_LIMITS.newFindingKeysPerRun, "maxFindingsPerRun must be between 1 and 2")
    .optional(),
  ...modelFields,
};

/** A custom Loop (no template) has nothing to run on without instructions. */
const instructionsRule = (
  value: { template?: string | null; instructions?: string },
  ctx: z.RefinementCtx,
) => {
  if (value.template) return;
  if ((value.instructions ?? "").trim().length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["instructions"],
      message: "instructions are required unless a template is chosen",
    });
  }
};

export const createLoopSchema = z.object({ name, ...loopFields }).superRefine(instructionsRule);
export type CreateLoopInput = z.input<typeof createLoopSchema>;

/** PATCH: every field optional; a field left out is untouched. */
export const updateLoopSchema = z
  .object({ name, ...loopFields })
  .partial()
  .superRefine((value, ctx) => {
    // Clearing the template needs instructions in the same patch; the service
    // rechecks against the stored row when only one of the two is sent.
    if (value.template === null) instructionsRule(value, ctx);
  });
export type UpdateLoopInput = z.input<typeof updateLoopSchema>;

export const loopStatusActionSchema = z.object({
  action: z.enum(["pause", "resume"], 'action must be "pause" or "resume"'),
});

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
  templateVersion: number | null;
  schedule: LoopSchedule;
  status: LoopStatus;
  pauseReason: LoopPauseReason | null;
  statusChangedAt: string;
  statusChangedBy: string | null;
  dryRun: boolean;
  precheckSql: string | null;
  lastPrecheckAt: string | null;
  lastPrecheckOutcome: string | null;
  model: string | null;
  provider: string | null;
  source: "system" | "byok" | null;
  maxFindingsPerRun: number;
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

export interface LoopFindingDto {
  signalId: string;
  title: string;
  status: string;
  groupKey: string | null;
  criteriaCovers: string;
  hitCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface LoopMemoryDto {
  id: string;
  /** null = shared by every Loop in the project. */
  loopId: string | null;
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
