import { Queue, Worker, type Job } from "bullmq";
import {
  prisma,
  SYSTEM_MODELS,
  PlanType,
  ModelSource,
  ALERT_WINDOWS,
  DEFAULT_ALERT_WINDOW,
  isAlertWindow,
} from "@traceroot/core";
import { fetchProviderConfig, resolvePiModel } from "@traceroot/core/model-resolver";
import type { DetectorRcaJob } from "../queues/detector-run-queue.js";
import { DETECTOR_RCA_QUEUE, createRedisConnection } from "../queues/detector-run-queue.js";
import {
  type DigestFlushJob,
  windowStartFor,
  createDetectorDigestQueue,
} from "../queues/digest-queue.js";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || "http://localhost:8100";

// Settle margin past the window's end before the flush reads ClickHouse, so a
// finding written at windowEnd−ε is visible. With finding-timestamp keying
// there is no RCA-latency drift, so a few seconds for write-visibility suffices.
const DIGEST_SETTLE_MS = Number(process.env.DIGEST_SETTLE_MS ?? 5_000);

let digestQueue: Queue<DigestFlushJob> | null = null;
function getDigestQueue(): Queue<DigestFlushJob> {
  if (!digestQueue) {
    digestQueue = createDetectorDigestQueue(createRedisConnection());
  }
  return digestQueue;
}

// Resolve a project-configured rca_model to the agent service body fields.
// Uses the same pattern as sandbox-eval.ts: reads the provider from saved
// config (BYOK) or the shared system-model resolver — no fragile prefix
// matching or adapter guessing.
// Returns null when the model is unset or unknown (caller should omit fields).
export async function resolveProjectModel(
  rcaModel: string | null | undefined,
  rcaProvider: string | null | undefined,
  rcaSource: string | null | undefined,
  workspaceId: string,
): Promise<{ model: string; providerName: string; source: ModelSource } | null> {
  if (!rcaModel) return null;

  // 1. BYOK: read provider from saved config (same pattern as sandbox-eval.ts L126-136)
  if (rcaSource === "byok" && rcaProvider) {
    const providerConfig = await fetchProviderConfig(workspaceId, rcaProvider);
    if (!providerConfig) {
      console.warn(
        `[detector-rca] BYOK provider "${rcaProvider}" not found or disabled in workspace ${workspaceId}`,
      );
      return null;
    }
    const model = resolvePiModel(rcaModel, providerConfig);
    // Forward the saved BYOK provider LABEL (e.g. "myopenai"), not the pi-ai
    // provider name. The agent resolves BYOK via fetchProviderConfig(workspaceId,
    // providerName), which keys on ModelProvider.provider (the user label).
    return { model: model.id, providerName: rcaProvider, source: ModelSource.BYOK };
  }

  // 2. System model: validate against catalog, then use shared resolver
  for (const group of SYSTEM_MODELS) {
    if (group.models.some((m) => m.id === rcaModel)) {
      const model = resolvePiModel(rcaModel, null);
      return { model: model.id, providerName: model.provider, source: ModelSource.SYSTEM };
    }
  }

  // 3. Legacy BYOK fallback for pre-existing configs
  const legacy = await resolveLegacyByok(rcaModel, workspaceId);
  if (legacy) return legacy;

  console.warn(`[detector-rca] Unknown rca_model "${rcaModel}", falling back to default`);
  return null;
}

// 3. Legacy BYOK fallback: projects that saved a BYOK model before
//    rcaSource and rcaProvider fields existed have both set to NULL.
//    Try to resolve the model from the workspace's enabled providers.
async function resolveLegacyByok(
  rcaModel: string,
  workspaceId: string,
): Promise<{ model: string; providerName: string; source: ModelSource } | null> {
  try {
    const dbProviders = await prisma.modelProvider.findMany({
      where: { workspaceId, enabled: true },
      select: { provider: true, customModels: true },
      orderBy: { id: "asc" },
    });

    for (const p of dbProviders) {
      if (p.customModels.some((m) => m.trim() === rcaModel)) {
        const providerConfig = await fetchProviderConfig(workspaceId, p.provider);
        if (providerConfig) {
          const model = resolvePiModel(rcaModel, providerConfig);
          // Forward the BYOK provider LABEL the agent expects (see step 1 above).
          return { model: model.id, providerName: p.provider, source: ModelSource.BYOK };
        }
      }
    }
  } catch (err) {
    console.error(
      `[detector-rca] Failed to resolve legacy BYOK for workspace ${workspaceId}:`,
      err,
    );
  }
  return null;
}

export async function runRcaSession(params: {
  findingId: string;
  projectId: string;
  workspaceId: string;
  traceId: string;
  findings: DetectorRcaJob["findings"];
  hasGitHub: boolean;
  rcaModel?: string | null;
  rcaProvider?: string | null;
  rcaSource?: string | null;
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

  const resolved = await resolveProjectModel(
    params.rcaModel,
    params.rcaProvider,
    params.rcaSource,
    params.workspaceId,
  );
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

export async function processRcaJob(job: Job<DetectorRcaJob>) {
  const { findingId, projectId, traceId, workspaceId, findings, findingTimestamp } = job.data;

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

  // Project alert aggregation window. Hoisted because `scheduleDigestFlush`
  // closes over it but `project` is fetched later in the try below. Defaults to
  // DEFAULT_ALERT_WINDOW until the project read resolves it.
  let alertWindow: string = DEFAULT_ALERT_WINDOW;

  // Every detector alert is a windowed digest: schedule one deduped flush per
  // (project, windowStart) keyed off the worker's finding-capture time, which is
  // close to (but a few ms before) the server-stamped detector_runs.timestamp
  // the flush reads back. The deterministic jobId makes
  // the first finding of the window schedule the flush and every later finding a
  // no-op enqueue. Age-based retention keeps a late re-enqueue (slow RCA) a no-op
  // past the largest window + RCA tail. Findings must never fail silently, so
  // this runs on both the success and failure paths; flushDigest re-resolves the
  // recipients and renders the digest.
  const scheduleDigestFlush = async () => {
    const windowMs = ALERT_WINDOWS[isAlertWindow(alertWindow) ? alertWindow : DEFAULT_ALERT_WINDOW];
    // Legacy/in-flight RCA jobs enqueued before findingTimestamp existed carry no
    // timestamp; fall back to now so the window key never goes NaN.
    const safeFindingTs =
      typeof findingTimestamp === "number" && Number.isFinite(findingTimestamp)
        ? findingTimestamp
        : Date.now();
    const windowStart = windowStartFor(safeFindingTs, windowMs);
    const delay = Math.max(0, windowStart + windowMs + DIGEST_SETTLE_MS - Date.now());
    await getDigestQueue().add(
      `digest-${projectId}-${windowStart}`,
      { projectId, windowStart, windowMs },
      {
        jobId: `digest:${projectId}:${windowStart}`,
        delay,
        removeOnComplete: { age: 6 * 3600 },
        removeOnFail: 50,
      },
    );
  };

  try {
    // Pull project-scoped rca_model and alert recipients in one read.
    // Inside the try so a Prisma failure routes through the catch's
    // failure-state + fallback-alert handling.
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        rcaModel: true,
        rcaProvider: true,
        rcaSource: true,
        alertConfig: { select: { alertWindow: true } },
      },
    });
    alertWindow = project?.alertConfig?.alertWindow ?? DEFAULT_ALERT_WINDOW;

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
      rcaProvider: project?.rcaProvider,
      rcaSource: project?.rcaSource,
    });

    await prisma.detectorRca.update({
      where: { findingId },
      data: {
        status: "done",
        result: rcaResult,
        completedAt: new Date(),
      },
    });
  } catch (e) {
    await prisma.detectorRca
      .update({ where: { findingId }, data: { status: "failed" } })
      .catch(() => {}); // best-effort

    await scheduleDigestFlush();

    throw e; // re-throw so BullMQ marks job as failed
  }

  // RCA state is persisted above; schedule the digest outside the try so a
  // transient enqueue failure retries the job without the catch reverting a
  // completed RCA to "failed".
  await scheduleDigestFlush();
}

export function startDetectorRcaWorker(): Worker<DetectorRcaJob> {
  const connection = createRedisConnection();
  const worker = new Worker<DetectorRcaJob>(DETECTOR_RCA_QUEUE, processRcaJob, {
    connection,
    concurrency: 3,
  });

  worker.on("failed", (job, err) => {
    console.error(`[RCA] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
