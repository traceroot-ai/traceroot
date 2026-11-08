import type { Prisma, PrismaClient } from "@traceroot/core";
import {
  skillsForRun,
  updateLinks,
  type UpdateFacts,
  type UpdateResult,
} from "@traceroot/core/updates";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import {
  AgentFailure,
  runUpdateAgent,
  TokenCapError,
  type SampleTraceDto,
  type SqlResultDto,
} from "./agent.js";
import { deliverRun, type DeliveryDeps } from "./deliver.js";
import type { ResolvedModel } from "./model.js";
import type { RenderContext } from "./render.js";
import type { SignalsRollup } from "./signals-rollup.js";

/**
 * The part of a run after the numbers: limits, the agent, the stored result and
 * delivery. Every step records where it got to on the run row, so a retry
 * continues from there: a stored result is never produced twice, and a channel
 * that has the message is never sent it again.
 */

export interface AgentStageDeps {
  resolveModel: (project: {
    workspaceId: string;
    rcaSource: string | null;
    rcaProvider: string | null;
    rcaModel: string | null;
  }) => Promise<ResolvedModel>;
  complete: (
    model: Model<Api>,
    context: Context,
    options?: ProviderStreamOptions,
  ) => Promise<AssistantMessage>;
  readSample: (projectId: string, run: StageRun, seed: number) => Promise<SampleTraceDto[]>;
  runSql: (projectId: string, query: string) => Promise<SqlResultDto>;
  delivery: DeliveryDeps;
  /** Per-turn lines from the agent, for development. */
  log?: (line: string) => void;
}

export type StageDb = Pick<PrismaClient, "projectUpdateRun" | "projectUpdateSchedule">;

export interface StageRun {
  id: string;
  projectId: string;
  frequency: string;
  windowStart: Date;
  windowEnd: Date;
  prevWindowStart: Date;
  prevWindowEnd: Date;
  createTime: Date;
  result: unknown;
  slackDeliveredAt: Date | null;
  slackMessageTs: string | null;
  slackThreadPosts: number;
  emailDeliveredAt: Date | null;
}

export interface StageProject {
  id: string;
  name: string;
  workspaceId: string;
  rcaSource: string | null;
  rcaProvider: string | null;
  rcaModel: string | null;
}

export type StageOutcome =
  | { status: "succeeded"; note: string | null }
  | { status: "stopped"; stopReason: "token_cap" | "spend_limit"; message: string }
  | { status: "failed"; error: string };

const DEFAULT_LIMITS = { runTokenCap: 200_000, monthlySpendCapUsd: 20 };

function startOfMonthUtc(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/** What an update says when there is nothing in it, made without asking a model. */
export function quietResult(facts: UpdateFacts): UpdateResult {
  const noTraffic = facts.nothingNotableReason === "no_traffic";
  return {
    nothingToReport: true,
    headline: noTraffic
      ? "No traffic in this window or the one before it."
      : "Nothing notable changed in this window.",
    summary: "",
    sections: [],
    suggestedDetectors: [],
    notesForNextRun: "",
  };
}

export async function runAgentStage(
  deps: AgentStageDeps & { db: StageDb; appBaseUrl: string; now?: () => Date },
  run: StageRun,
  project: StageProject,
  facts: UpdateFacts,
  rollup: SignalsRollup,
  frequency: "daily" | "weekly",
): Promise<StageOutcome> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  let result = run.result as UpdateResult | null;
  if (!result) {
    const schedule = await db.projectUpdateSchedule.findUnique({
      where: { projectId: run.projectId },
    });
    const limits = {
      runTokenCap: schedule?.runTokenCap ?? DEFAULT_LIMITS.runTokenCap,
      monthlySpendCapUsd: schedule?.monthlySpendCapUsd ?? DEFAULT_LIMITS.monthlySpendCapUsd,
    };

    const quiet =
      facts.nothingNotable &&
      rollup.new.length === 0 &&
      rollup.resolved.length === 0 &&
      rollup.spiking.length === 0;
    if (quiet) {
      result = quietResult(facts);
      await db.projectUpdateRun.update({
        where: { id: run.id },
        data: { result: result as unknown as Prisma.InputJsonValue, skillsRan: [] },
      });
    } else {
      const spent = await db.projectUpdateRun.aggregate({
        where: {
          projectId: run.projectId,
          id: { not: run.id },
          createTime: { gte: startOfMonthUtc(now()) },
        },
        _sum: { costUsd: true },
      });
      const spentUsd = spent._sum.costUsd ?? 0;
      if (spentUsd >= limits.monthlySpendCapUsd) {
        return {
          status: "stopped",
          stopReason: "spend_limit",
          message: `This project has used $${spentUsd.toFixed(2)} of its $${limits.monthlySpendCapUsd.toFixed(2)} monthly update limit.`,
        };
      }

      const resolved = await deps.resolveModel(project);
      if (!resolved.ok) return { status: "failed", error: resolved.error };

      const skills = skillsForRun({ frequency, codeChangesEnabled: false });
      const seed = Math.floor(run.windowEnd.getTime() / 1000) % 2_147_483_647;
      try {
        const out = await runUpdateAgent({
          projectId: project.id,
          projectName: project.name,
          appBaseUrl: deps.appBaseUrl,
          facts,
          signalsRollup: rollup,
          links: updateLinks(deps.appBaseUrl, project.id),
          notes: await previousNotes(db, run),
          skills,
          tokenCap: limits.runTokenCap,
          model: resolved.model,
          apiKey: resolved.apiKey,
          complete: deps.complete,
          readSample: () => deps.readSample(project.id, run, seed),
          runSql: (query) => deps.runSql(project.id, query),
          log: deps.log,
        });
        result = out.result;
        await db.projectUpdateRun.update({
          where: { id: run.id },
          data: {
            result: result as unknown as Prisma.InputJsonValue,
            skillsRan: out.skillsRan,
            model: resolved.model.id,
            tokensIn: out.usage.inputTokens,
            tokensOut: out.usage.outputTokens,
            costUsd: out.usage.costUsd,
          },
        });
      } catch (error) {
        if (error instanceof TokenCapError) {
          await db.projectUpdateRun.update({
            where: { id: run.id },
            data: {
              model: resolved.model.id,
              tokensIn: error.usage.inputTokens,
              tokensOut: error.usage.outputTokens,
              costUsd: error.usage.costUsd,
            },
          });
          return { status: "stopped", stopReason: "token_cap", message: error.message };
        }
        if (error instanceof AgentFailure) {
          await db.projectUpdateRun.update({
            where: { id: run.id },
            data: {
              tokensIn: error.usage.inputTokens,
              tokensOut: error.usage.outputTokens,
              costUsd: error.usage.costUsd,
            },
          });
          return { status: "failed", error: error.message };
        }
        return { status: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  // Send nothing when there is nothing to report.
  if (result.nothingToReport) {
    return { status: "succeeded", note: "Nothing to report; no message was sent." };
  }

  const ctx: RenderContext = {
    appBaseUrl: deps.appBaseUrl,
    projectId: project.id,
    projectName: project.name,
    windowStart: run.windowStart,
    windowEnd: run.windowEnd,
    frequency,
  };
  const delivered = await deliverRun(deps.delivery, run, result, ctx);
  return {
    status: "succeeded",
    note: delivered.notes.length > 0 ? delivered.notes.join(" ") : null,
  };
}

async function previousNotes(db: StageDb, run: StageRun): Promise<string | null> {
  const previous = await db.projectUpdateRun.findFirst({
    where: {
      projectId: run.projectId,
      id: { not: run.id },
      status: "succeeded",
      slotAt: { lt: run.windowEnd },
    },
    orderBy: { slotAt: "desc" },
    select: { result: true },
  });
  const notes = (previous?.result as { notesForNextRun?: string } | null)?.notesForNextRun;
  return notes && notes.trim() !== "" ? notes : null;
}
