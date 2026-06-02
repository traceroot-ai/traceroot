import { Worker, type Job } from "bullmq";
import { prisma, SYSTEM_MODELS, PlanType, ModelSource } from "@traceroot/core";
import type { DetectorRcaJob } from "../queues/detector-run-queue.js";
import { DETECTOR_RCA_QUEUE, createRedisConnection } from "../queues/detector-run-queue.js";
import { sendCombinedAlertEmail } from "../notifications/email.js";
import { sendCombinedAlertSlack } from "../notifications/slack.js";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || "http://localhost:8100";

// Resolve a project-configured rca_model id to the agent service body fields.
// Returns null when the model is unset or unknown (caller should omit fields).
export async function resolveProjectModel(
  rcaModel: string | null | undefined,
  workspaceId: string,
): Promise<{ model: string; providerName: string; source: ModelSource } | null> {
  if (!rcaModel) return null;
  for (const group of SYSTEM_MODELS) {
    if (group.models.some((m) => m.id === rcaModel)) {
      return { model: rcaModel, providerName: group.piAIProvider, source: ModelSource.SYSTEM };
    }
  }

  try {
    const dbProviders = await prisma.modelProvider.findMany({
      where: { workspaceId, enabled: true },
      select: {
        provider: true,
        customModels: true,
      },
    });

    for (const p of dbProviders) {
      if (p.customModels.some((m) => m.trim() === rcaModel)) {
        return { model: rcaModel, providerName: p.provider, source: ModelSource.BYOK };
      }
    }
  } catch (err) {
    console.error(
      `[detector-rca] Failed to query model providers for workspace ${workspaceId}:`,
      err,
    );
  }

  console.warn(`[detector-rca] Unknown rca_model "${rcaModel}", falling back to default`);
  return null;
}

async function runRcaSession(params: {
  findingId: string;
  projectId: string;
  workspaceId: string;
  traceId: string;
  findings: DetectorRcaJob["findings"];
  hasGitHub: boolean;
  rcaModel?: string | null;
}): Promise<{ result: string; sessionId: string }> {
  const sessionRes = await fetch(
    `${AGENT_SERVICE_URL}/api/v1/projects/${params.projectId}/sessions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-workspace-id": params.workspaceId,
        // no x-user-id — system session, userId stored as null
      },
      body: JSON.stringify({
        title: `[RCA] ${params.findings.map((f) => f.detectorName).join(", ")} — ${params.traceId.slice(0, 8)}`,
      }),
    },
  );
  if (!sessionRes.ok) {
    throw new Error(`Failed to create RCA session: HTTP ${sessionRes.status}`);
  }
  const session = await sessionRes.json();

  // Persist sessionId immediately so the UI can open the RCA chat even if the
  // agent run later fails — the user can read the prompt + partial output and
  // continue the conversation in the same session. Upsert (not update) because
  // the seed row from detector-run-processor is best-effort and may be missing.
  await prisma.detectorRca.upsert({
    where: { findingId: params.findingId },
    create: {
      findingId: params.findingId,
      projectId: params.projectId,
      status: "running",
      sessionId: session.id,
    },
    update: { sessionId: session.id },
  });

  const findingsList = params.findings
    .map((f, i) => `${i + 1}. Detector "${f.detectorName}" fired:\n   ${f.summary}`)
    .join("\n\n");

  const githubNote = params.hasGitHub
    ? "If any spans contain git_source_file and git_source_line, read that source code and check recent commits/PRs touching that file."
    : "";

  const prompt = `${params.findings.length === 1 ? "A detector fired" : `${params.findings.length} detectors fired`} on this trace.

${findingsList}

Trace ID: ${params.traceId}

Download and analyze this trace. Identify the root cause${params.findings.length > 1 ? " shared across these findings" : ""}.
${githubNote}

Output your findings in this format:
- Root cause: [one sentence]
- Code location: [file:line if found, else "not identified"]
- Recent changes: [relevant commits/PRs if found, else "not checked"]
- Recommendation: [one actionable sentence]`;

  const msgHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-workspace-id": params.workspaceId,
  };
  console.log("[detector-rca]", "project.rcaModel=", params.rcaModel);
  const resolved = await resolveProjectModel(params.rcaModel, params.workspaceId);
  const msgBody: {
    message: string;
    traceId: string;
    model?: string;
    providerName?: string;
    source?: ModelSource;
  } = { message: prompt, traceId: params.traceId };
  if (resolved) {
    msgBody.model = resolved.model;
    msgBody.providerName = resolved.providerName;
    msgBody.source = resolved.source;
  }

  const msgRes = await fetch(
    `${AGENT_SERVICE_URL}/api/v1/projects/${params.projectId}/sessions/${session.id}/messages`,
    {
      method: "POST",
      headers: msgHeaders,
      body: JSON.stringify(msgBody),
    },
  );

  if (!msgRes.ok) {
    throw new Error(`Failed to send RCA message: HTTP ${msgRes.status}`);
  }

  // Consume SSE stream, accumulate assistant text
  let rcaResult = "";
  const reader = msgRes.body!.getReader();
  const decoder = new TextDecoder();
  let remainder = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = remainder + decoder.decode(value, { stream: true });
    const lines = text.split("\n");
    remainder = lines.pop() ?? ""; // last element: incomplete or empty
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const event = JSON.parse(line.slice(6));
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent?.type === "text_delta" &&
            event.assistantMessageEvent.delta
          ) {
            rcaResult += event.assistantMessageEvent.delta;
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  }

  return { result: rcaResult, sessionId: session.id };
}

// ---------------------------------------------------------------------------
// Fan-out helper — exported for unit testing
// ---------------------------------------------------------------------------

export interface FanOutCommon {
  detectorName: string;
  projectName: string;
  summary: string;
  rcaResult: string | null;
  traceId: string;
  projectId: string;
}

export interface RunFanOutParams {
  workspaceId: string;
  emailAddresses: string[];
  slackChannelId: string | null;
  slackBotTokenEnc: string | null;
  common: FanOutCommon;
}

export async function runFanOut({
  workspaceId,
  emailAddresses,
  slackChannelId,
  slackBotTokenEnc,
  common,
}: RunFanOutParams): Promise<void> {
  const tasks: Promise<unknown>[] = [];

  if (emailAddresses.length > 0) {
    tasks.push(
      sendCombinedAlertEmail({ to: emailAddresses, ...common }).catch((e) =>
        console.error(`[RCA] Alert email failed for trace ${common.traceId}:`, e),
      ),
    );
  }

  if (slackChannelId && slackBotTokenEnc) {
    tasks.push(
      sendCombinedAlertSlack({
        workspaceId,
        encryptedBotToken: slackBotTokenEnc,
        channelId: slackChannelId,
        ...common,
      }).catch((e) => console.error(`[RCA] Slack send failed for trace ${common.traceId}:`, e)),
    );
  }

  await Promise.allSettled(tasks);
}

export function startDetectorRcaWorker(): Worker<DetectorRcaJob> {
  const connection = createRedisConnection();

  const worker = new Worker<DetectorRcaJob>(
    DETECTOR_RCA_QUEUE,
    async (job: Job<DetectorRcaJob>) => {
      const { findingId, projectId, traceId, workspaceId, projectName, findings } = job.data;

      // Free-plan RCA cap enforcement — read the cached `rcaBlocked` flag
      // set by the hourly billing job (same pattern as `detectorBlocked` in
      // detector-run-processor). Worst-case overshoot: ~1h of RCA runs
      // between cron passes.
      const ws = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { billingPlan: true, rcaBlocked: true },
      });
      if (ws?.rcaBlocked && (ws.billingPlan as PlanType) === PlanType.FREE) {
        // detector-run-processor pre-seeds a DetectorRca row with
        // status="pending" before enqueuing; mark it terminal so the UI
        // doesn't show a permanently-stuck "in progress" RCA.
        await prisma.detectorRca
          .update({
            where: { findingId },
            data: {
              status: "failed",
              result: "Skipped — Free plan RCA quota exceeded. Upgrade to continue.",
              completedAt: new Date(),
            },
          })
          .catch(() => {}); // best-effort; row may not exist if pre-seed failed
        console.log(
          `[RCA] Workspace ${workspaceId} is rca-blocked (Free plan cap exceeded); ` +
            `skipping RCA for finding ${findingId}`,
        );
        return;
      }

      await prisma.detectorRca.upsert({
        where: { findingId },
        create: { findingId, projectId, status: "running" },
        update: { projectId, status: "running" },
      });

      // emailAddresses is captured inside the try below; declare here so the
      // outer catch's fallback alert can still use it (defaults to []).
      let emailAddresses: string[] = [];

      let slackChannelId: string | null = null;

      let slackBotTokenEnc: string | null = null;

      // Always send a combined alert (success: with RCA result; failure: null).
      // Detector findings should never fail silently on configured channels.
      const sendAlert = async (rcaResult: string | null) => {
        const summary = findings.map((f) => `[${f.detectorName}] ${f.summary}`).join("\n");
        const detectorName = findings.map((f) => f.detectorName).join(", ");
        const common = { detectorName, projectName, summary, rcaResult, traceId, projectId };
        await runFanOut({
          workspaceId,
          emailAddresses,
          slackChannelId,
          slackBotTokenEnc,
          common,
        });
      };

      try {
        // Pull project-scoped rca_model and alert recipients in one read.
        // Inside the try so a Prisma failure routes through the catch's
        // failure-state + fallback-alert handling.
        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: {
            rcaModel: true,
            alertConfig: {
              select: { emailAddresses: true, slackChannelId: true, slackChannelName: true },
            },
            workspace: {
              select: {
                slackIntegration: {
                  select: { channelId: true, channelName: true, botToken: true },
                },
              },
            },
          },
        });
        emailAddresses = project?.alertConfig?.emailAddresses ?? [];

        const slack = project?.workspace?.slackIntegration ?? null;
        slackChannelId = project?.alertConfig?.slackChannelId ?? slack?.channelId ?? null;
        slackBotTokenEnc = slack?.botToken ?? null;

        // Workspace-level GitHub installations now drive the GitHub tool.
        // Any installation in this workspace is enough to flip the tool on.
        const ghCount = await prisma.gitHubInstallation.count({
          where: { workspaceId },
        });
        const hasGitHub = ghCount > 0;

        const { result: rcaResult } = await runRcaSession({
          findingId,
          projectId,
          workspaceId,
          traceId,
          findings,
          hasGitHub,
          rcaModel: project?.rcaModel,
        });

        await prisma.detectorRca.update({
          where: { findingId },
          data: {
            status: "done",
            result: rcaResult,
            completedAt: new Date(),
          },
        });

        await sendAlert(rcaResult);
      } catch (e) {
        await prisma.detectorRca
          .update({ where: { findingId }, data: { status: "failed" } })
          .catch(() => {}); // best-effort

        await sendAlert(null);

        throw e; // re-throw so BullMQ marks job as failed
      }
    },
    { connection, concurrency: 3 },
  );

  worker.on("failed", (job, err) => {
    console.error(`[RCA] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
