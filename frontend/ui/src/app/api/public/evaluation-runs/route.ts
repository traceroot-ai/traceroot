import { NextResponse } from "next/server";
import { prisma, RegisterRunRequestSchema, type RegisterRunResponse } from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";

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
    const result = await prisma.$transaction(async (tx) => {
      const dataset = await tx.dataset.findFirst({
        where: { id: req.dataset_id, projectId },
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
        where: { id: versionId, datasetId: req.dataset_id, projectId },
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

      const evaluation =
        (await tx.evaluation.findFirst({
          where: { projectId, datasetId: req.dataset_id, name: req.evaluation_name },
          select: { id: true },
        })) ??
        (await tx.evaluation.create({
          data: {
            projectId,
            datasetId: req.dataset_id,
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
          datasetId: req.dataset_id,
          datasetVersionId: versionId,
          runNumber,
          candidateVersion: req.candidate_version,
          environment: req.environment,
          status: "running",
          baselineRunId: req.baseline_run_id ?? null,
          mainScoreName: req.main_score_name ?? null,
          caseCount,
          scorers: req.scorers,
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
        } satisfies RegisterRunResponse,
      };
    });

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
