import { Worker, type Job } from "bullmq";
import { prisma, SYSTEM_MODELS } from "@traceroot/core";
import type { DetectorRcaJob } from "../queues/detector-run-queue.js";
import { DETECTOR_RCA_QUEUE, createRedisConnection } from "../queues/detector-run-queue.js";
import { sendCombinedAlertEmail } from "../notifications/email.js";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || "http://localhost:8100";

// Resolve a project-configured rca_model id to the agent service body fields.
// Returns null when the model is unset or unknown (caller should omit fields).
function resolveSystemModel(
  rcaModel: string | null | undefined,
): { model: string; providerName: string; source: "system" } | null {
  if (!rcaModel) return null;
  for (const group of SYSTEM_MODELS) {
    if (group.models.some((m) => m.id === rcaModel)) {
      return { model: rcaModel, providerName: group.piAIProvider, source: "system" };
    }
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

  const resolved = resolveSystemModel(params.rcaModel);
  const msgBody: {
    message: string;
    traceId: string;
    model?: string;
    providerName?: string;
    source?: "system";
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

export function startDetectorRcaWorker(): Worker<DetectorRcaJob> {
  const connection = createRedisConnection();

  const worker = new Worker<DetectorRcaJob>(
    DETECTOR_RCA_QUEUE,
    async (job: Job<DetectorRcaJob>) => {
      const { findingId, projectId, traceId, workspaceId, projectName, findings } = job.data;

      await prisma.detectorRca.upsert({
        where: { findingId },
        create: { findingId, projectId, status: "running" },
        update: { projectId, status: "running" },
      });

      // emailAddresses is captured inside the try below; declare here so the
      // outer catch's fallback alert can still use it (defaults to []).
      let emailAddresses: string[] = [];

      // Always send a combined alert (success: with RCA result; failure: null).
      // Detector findings should never fail silently on configured channels.
      const sendAlert = (rcaResult: string | null) => {
        if (emailAddresses.length === 0) return Promise.resolve();
        const summary = findings.map((f) => `[${f.detectorName}] ${f.summary}`).join("\n");
        return sendCombinedAlertEmail({
          to: emailAddresses,
          detectorName: findings.map((f) => f.detectorName).join(", "),
          projectName,
          summary,
          rcaResult,
          traceId,
          projectId,
        }).catch((e) => console.error(`[RCA] Alert email failed for trace ${traceId}:`, e));
      };

      try {
        // Pull project-scoped rca_model and alert recipients in one read.
        // Inside the try so a Prisma failure routes through the catch's
        // failure-state + fallback-alert handling.
        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { rcaModel: true, alertConfig: { select: { emailAddresses: true } } },
        });
        emailAddresses = project?.alertConfig?.emailAddresses ?? [];

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
          data: { status: "done", result: rcaResult, completedAt: new Date() },
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
