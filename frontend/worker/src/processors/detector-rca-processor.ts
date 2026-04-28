import { Worker, type Job } from "bullmq";
import { prisma } from "@traceroot/core";
import type { DetectorRcaJob } from "../queues/detector-run-queue.js";
import { DETECTOR_RCA_QUEUE, createRedisConnection } from "../queues/detector-run-queue.js";
import { sendCombinedAlertEmail } from "../notifications/email.js";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || "http://localhost:8100";

async function runRcaSession(params: {
  findingId: string;
  projectId: string;
  workspaceId: string;
  traceId: string;
  findings: DetectorRcaJob["findings"];
  hasGitHub: boolean;
  githubUserId?: string;
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
  if (params.githubUserId) {
    msgHeaders["x-user-id"] = params.githubUserId;
  }

  const msgRes = await fetch(
    `${AGENT_SERVICE_URL}/api/v1/projects/${params.projectId}/sessions/${session.id}/messages`,
    {
      method: "POST",
      headers: msgHeaders,
      body: JSON.stringify({ message: prompt, traceId: params.traceId }),
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

  // Store session ID so the UI can open the RCA chat by finding_id
  await prisma.detectorRca.update({
    where: { findingId: params.findingId },
    data: { sessionId: session.id },
  });

  return { result: rcaResult, sessionId: session.id };
}

export function startDetectorRcaWorker(): Worker<DetectorRcaJob> {
  const connection = createRedisConnection();

  const worker = new Worker<DetectorRcaJob>(
    DETECTOR_RCA_QUEUE,
    async (job: Job<DetectorRcaJob>) => {
      const { findingId, projectId, traceId, workspaceId, projectName, findings, emailAddresses } =
        job.data;

      await prisma.detectorRca.upsert({
        where: { findingId },
        create: { findingId, projectId, status: "running" },
        update: { status: "running" },
      });

      try {
        // Find any workspace member with a GitHub connection for the GitHub tool.
        // TODO (PR 2): replace with project-level GitHubConnection lookup.
        const members = await prisma.workspaceMember.findMany({
          where: { workspaceId },
          include: { user: { include: { githubConnection: true } } },
        });
        const hasGitHub = members.some((m) => !!m.user.githubConnection);
        const githubUserId = members.find((m) => !!m.user.githubConnection)?.userId;

        const { result: rcaResult } = await runRcaSession({
          findingId,
          projectId,
          workspaceId,
          traceId,
          findings,
          hasGitHub,
          githubUserId,
        });

        await prisma.detectorRca.update({
          where: { findingId },
          data: { status: "done", result: rcaResult, completedAt: new Date() },
        });

        // Send combined alert email (all findings + RCA result in one message)
        if (emailAddresses.length > 0) {
          const summary = findings.map((f) => `[${f.detectorName}] ${f.summary}`).join("\n");
          await sendCombinedAlertEmail({
            to: emailAddresses,
            detectorName: findings.map((f) => f.detectorName).join(", "),
            projectName,
            summary,
            rcaResult,
            traceId,
            projectId,
          }).catch((e) =>
            console.error(`[RCA] Combined alert email failed for trace ${traceId}:`, e),
          );
        }
      } catch (e) {
        await prisma.detectorRca
          .update({
            where: { findingId },
            data: { status: "failed" },
          })
          .catch(() => {}); // best-effort

        // Send fallback email — RCA failed but never stay silent
        if (emailAddresses.length > 0) {
          const summary = findings.map((f) => `[${f.detectorName}] ${f.summary}`).join("\n");
          await sendCombinedAlertEmail({
            to: emailAddresses,
            detectorName: findings.map((f) => f.detectorName).join(", "),
            projectName,
            summary,
            rcaResult: null,
            traceId,
            projectId,
          }).catch((emailErr) =>
            console.error(`[RCA] Fallback email failed for trace ${traceId}:`, emailErr),
          );
        }

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
