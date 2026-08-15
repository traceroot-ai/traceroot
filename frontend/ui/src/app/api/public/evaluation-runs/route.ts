import { NextResponse } from "next/server";
import {
  prisma,
  Prisma,
  RegisterRunRequestSchema,
  type RegisterRunResponse,
  type RegisterRunRequest,
} from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";

const DEFAULT_APP_BASE_URL = "http://localhost:3000";

// The control plane's public app origin, used to make the run link absolute so it
// resolves regardless of how the API and UI origins are split (the SDK's host_url is
// the API origin, which need not serve the UI). Mirrors the auth/slack conventions.
// Deliberately server configuration only: deriving the origin from the request's Host
// or X-Forwarded-* headers would let the caller choose the link we hand back and the
// SDK prints into CI logs.
function appBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) return DEFAULT_APP_BASE_URL;
  try {
    return new URL(configured).toString();
  } catch {
    // A misconfigured origin must not fail registration — the run itself is fine.
    console.error(
      `NEXT_PUBLIC_APP_URL is not a valid URL (${configured}); ` +
        `falling back to ${DEFAULT_APP_BASE_URL} for run links`,
    );
    return DEFAULT_APP_BASE_URL;
  }
}

/** The run's UI-relative path + the absolute clickable URL for the SDK to print. */
function runLink(projectId: string, runId: string): { run_path: string; run_url: string } {
  const run_path = `/projects/${projectId}/evaluations/${runId}`;
  return { run_path, run_url: new URL(run_path, appBaseUrl()).toString() };
}

type RegisterOutcome =
  | { httpError: { message: string; status: number }; response?: undefined }
  | { response: RegisterRunResponse; httpError?: undefined };

/**
 * A unique-constraint violation from the register transaction. Every unique index
 * this transaction can touch marks a race with a concurrent registration:
 *   uq_evaluation_project_name    — two processes created the same lineage,
 *   uq_run_evaluation_run_number  — two runs allocated the same run_number,
 *   uq_run_client_run_id          — an SDK retry raced its own original request.
 * All three are resolved by replaying the transaction (see POST).
 */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Resolve the lineage, apply the client_run_id short-circuit, allocate run_number and
 * insert the run. Every read-then-write in here is backed by a unique index, so losing
 * a race raises P2002 rather than corrupting the lineage; the caller replays.
 */
async function registerRun(
  tx: Prisma.TransactionClient,
  projectId: string,
  req: RegisterRunRequest,
): Promise<RegisterOutcome> {
  // The SDK's `dataset_id` is the project-scoped client id, never the internal PK
  // (which is an auto-generated cuid the caller never sees) — resolve it here and
  // thread the internal `dataset.id` through the version, evaluation and run below.
  // Looking up by the internal id would 404 every SDK-registered run.
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
  // version is recorded on the run, and comparison flags a dataset mismatch.
  // uq_evaluation_project_name makes that identity a database invariant, so two
  // processes registering the same name (a CI matrix, parallel pytest shards)
  // cannot both insert and split the history: the loser gets P2002 and finds the
  // winner's row on replay.
  const evaluation =
    (await tx.evaluation.findUnique({
      where: { projectId_name: { projectId, name: req.evaluation_name } },
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

  // Idempotency: re-registering with the same client_run_id returns the run. This
  // read only covers a retry that arrives after the original committed; a retry that
  // overlaps it misses here and is caught by uq_run_client_run_id on the insert.
  if (req.client_run_id) {
    const existing = await tx.evaluationRun.findUnique({
      where: {
        evaluationId_clientRunId: {
          evaluationId: evaluation.id,
          clientRunId: req.client_run_id,
        },
      },
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
  // max + 1 is not serialised by READ COMMITTED, so two concurrent registrations can
  // read the same N. uq_run_evaluation_run_number rejects the second insert rather
  // than letting two runs share a number, and the replay re-reads the new max.
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
      // Typed execution provenance (git/CI/SDK + declared candidate model/prompt),
      // kept distinct from free-form `metadata`. Absent when the SDK reports none.
      provenance: (req.provenance ?? undefined) as Prisma.InputJsonValue | undefined,
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
}

// A lost race is replayed, not reported: Postgres only raises the unique violation
// once the winning transaction has committed, so the replay's reads see its row and
// converge on it. Bounded so a genuine, non-racing P2002 cannot spin.
const MAX_REGISTER_ATTEMPTS = 4;

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

  for (let attempt = 1; attempt <= MAX_REGISTER_ATTEMPTS; attempt++) {
    try {
      const result = await prisma.$transaction((tx) => registerRun(tx, projectId, req));
      if (result.httpError) {
        return NextResponse.json(
          { error: result.httpError.message },
          { status: result.httpError.status },
        );
      }
      return NextResponse.json(result.response, { status: 201 });
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_REGISTER_ATTEMPTS) continue;
      // Anything else — a P2003 on baseline_run_id, a transaction timeout, a
      // connection drop — is a real fault and unobservable unless logged here.
      console.error(
        `Failed to register evaluation run (project ${projectId}, attempt ${attempt})`,
        err,
      );
      return NextResponse.json({ error: "Failed to register run" }, { status: 500 });
    }
  }
  // Unreachable: the loop only leaves via a return.
  return NextResponse.json({ error: "Failed to register run" }, { status: 500 });
}
