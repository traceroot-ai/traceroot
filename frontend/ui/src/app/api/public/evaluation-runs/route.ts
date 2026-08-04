import { NextResponse } from "next/server";
import {
  prisma,
  Prisma,
  RegisterRunRequestSchema,
  type RegisterRunResponse,
} from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";

// The control plane's public app origin, used to make the run link absolute so it
// resolves regardless of how the API and UI origins are split (the SDK's host_url is
// the API origin, which need not serve the UI). Mirrors the auth/slack conventions.
const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

/** The run's UI-relative path + the absolute clickable URL for the SDK to print. */
function runLink(projectId: string, runId: string): { run_path: string; run_url: string } {
  const run_path = `/projects/${projectId}/evaluations/${runId}`;
  return { run_path, run_url: new URL(run_path, APP_BASE_URL).toString() };
}

// POST /api/public/evaluation-runs — SDK registers/starts a run (API-key auth).
// Idempotent on client_run_id within an evaluation. The evaluation lineage is
// resolved (create-if-absent) from evaluation_name + dataset_id; the server
// assigns run_number and all ids. Pins the dataset's current version when
// dataset_version_id is omitted.
export async function POST(request: Request) {
  const auth = await requireApiKeyProject(request);
  if (auth.error) return auth.error;
  const { projectId } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = RegisterRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const req = parsed.data;

  try {
    const runRegistration = async (tx: Prisma.TransactionClient) => {
      // The SDK's dataset_id is the project-scoped client id, never the internal PK.
      const dataset = await tx.dataset.findUnique({
        where: { projectId_clientDatasetId: { projectId, clientDatasetId: req.dataset_id } },
        select: { id: true, currentVersionId: true },
      });
      if (!dataset) return { httpError: { message: "Dataset not found", status: 404 } };

      const versionId = req.dataset_version_id ?? dataset.currentVersionId;
      if (!versionId) {
        return {
          httpError: { message: "Dataset has no published version to pin", status: 400 },
        };
      }
      const version = await tx.datasetVersion.findFirst({
        where: { id: versionId, datasetId: dataset.id, projectId },
        select: { id: true },
      });
      if (!version) return { httpError: { message: "Dataset version not found", status: 400 } };

      if (req.baseline_run_id) {
        const baseline = await tx.evaluationRun.findFirst({
          where: { id: req.baseline_run_id, projectId },
          select: { id: true },
        });
        if (!baseline) {
          return { httpError: { message: "Baseline run not found", status: 400 } };
        }
      }

      // An evaluation is identified by (project, name) — runs of the same-named
      // evaluation are additive (run #N) and comparable, even when the dataset id
      // churns (e.g. the SDK creates a fresh Dataset each run). The per-run dataset /
      // version is recorded on the run, and comparison flags a dataset mismatch. Oldest
      // same-named evaluation wins so grouping is stable. Looking up with datasetId too
      // would miss an eval first registered against another dataset and then fail the
      // (projectId, name) constraint on create with a 500 instead of reusing it.
      const evaluation =
        (await tx.evaluation.findFirst({
          where: { projectId, name: req.evaluation_name },
          orderBy: { createTime: "asc" },
          select: { id: true },
        })) ??
        (await tx.evaluation.create({
          data: {
            projectId,
            datasetId: dataset.id,
            name: req.evaluation_name,
            mainScoreName: req.main_score_name ?? "Score",
          },
          select: { id: true },
        }));

      // Idempotency: re-registering with the same client_run_id returns the run.
      if (req.client_run_id) {
        const existing = await tx.evaluationRun.findFirst({
          where: { evaluationId: evaluation.id, clientRunId: req.client_run_id },
          select: { id: true, runNumber: true, datasetVersionId: true },
        });
        if (existing) {
          return {
            response: {
              evaluation_id: evaluation.id,
              evaluation_run_id: existing.id,
              run_number: existing.runNumber,
              dataset_version_id: existing.datasetVersionId,
              ...runLink(projectId, existing.id),
            } satisfies RegisterRunResponse,
          };
        }
      }

      const caseCount =
        req.case_count ?? (await tx.testCase.count({ where: { datasetVersionId: versionId } }));
      const last = await tx.evaluationRun.findFirst({
        where: { evaluationId: evaluation.id },
        orderBy: { runNumber: "desc" },
        select: { runNumber: true },
      });
      const runNumber = (last?.runNumber ?? 0) + 1;

      const run = await tx.evaluationRun.create({
        data: {
          evaluationId: evaluation.id,
          projectId,
          datasetId: dataset.id,
          datasetVersionId: versionId,
          runNumber,
          candidateVersion: req.candidate_version,
          environment: req.environment,
          status: "running",
          baselineRunId: req.baseline_run_id ?? null,
          mainScoreName: req.main_score_name ?? null,
          caseCount,
          // The full scorer manifest — identity ({name, version}), config
          // (value_type/direction/threshold) and the read-only DEFINITION
          // (scorer_type, prompt/source) — rides along in this JSON column when the
          // SDK sends it; a legacy {name, version} scorer stays valid. Cast because
          // the scorer metadata field is typed `unknown` (arbitrary JSON).
          scorers: req.scorers as unknown as Prisma.InputJsonValue,
          metadata: (req.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
          clientRunId: req.client_run_id ?? null,
        },
        select: { id: true, runNumber: true, datasetVersionId: true },
      });

      return {
        response: {
          evaluation_id: evaluation.id,
          evaluation_run_id: run.id,
          run_number: run.runNumber,
          dataset_version_id: run.datasetVersionId,
          ...runLink(projectId, run.id),
        } satisfies RegisterRunResponse,
      };
    };

    // Retry the registration on a unique-key collision: concurrent first registrations
    // can read the same max run number (or race the client_run_id insert) and one loses
    // uq_run_evaluation_run_number — a normal parallel SDK call, not a 500. Each attempt
    // re-reads the max in a fresh transaction.
    let result: Awaited<ReturnType<typeof runRegistration>> | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        result = await prisma.$transaction(runRegistration);
        break;
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002" &&
          attempt < 4
        ) {
          continue;
        }
        throw e;
      }
    }
    if (!result) {
      return NextResponse.json({ error: "Failed to register run" }, { status: 500 });
    }

    if ("httpError" in result && result.httpError) {
      return NextResponse.json(
        { error: result.httpError.message },
        { status: result.httpError.status },
      );
    }
    return NextResponse.json(result.response, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to register run" }, { status: 500 });
  }
}
