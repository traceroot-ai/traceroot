import { NextResponse } from "next/server";
import {
  prisma,
  Prisma,
  RegisterRunRequestSchema,
  type RegisterRunResponse,
  type RegisterRunRequest,
} from "@traceroot/core";
import { requireApiKeyProject } from "@/lib/eval/auth";
import { runLink } from "@/lib/eval/run-link";
import { resolvePublicDataset } from "@/lib/eval/versions";

type RegisterOutcome =
  | { httpError: { message: string; status: number }; response?: undefined }
  | { response: RegisterRunResponse; httpError?: undefined };

/**
 * A unique-constraint violation from the register transaction. Every unique index
 * this transaction can touch marks a race with a concurrent registration:
 *   uq_evaluation_project_key     — two processes created the same lineage,
 *   uq_run_evaluation_run_number  — two runs allocated the same run_number,
 *   uq_run_client_run_id          — an SDK retry raced its own original request.
 * All three are resolved by replaying the transaction (see POST).
 */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** A run's stored dataset coverage — all null together when the SDK declared none. */
type StoredCoverage = {
  datasetCaseCount: number | null;
  selectionMode: string | null;
  selectedCaseCount: number | null;
  sampleSeed: number | null;
};

/** The stored row as Prisma reads it: `sample_seed` is BIGINT and comes back a `bigint`. */
type StoredCoverageRow = Omit<StoredCoverage, "sampleSeed"> & { sampleSeed: bigint | null };

function fromRow(row: StoredCoverageRow): StoredCoverage {
  // The contract bounds a seed to a safe integer, so the conversion is exact.
  return { ...row, sampleSeed: row.sampleSeed === null ? null : Number(row.sampleSeed) };
}

/**
 * Flatten a request's coverage block into the stored column shape. The contract
 * guarantees `dataset_case_count` and `run_selection` arrive together or not at all,
 * so this is all-null or all-populated (bar `sample_seed`, which only a sample carries).
 */
function coverageColumns(req: RegisterRunRequest): StoredCoverage {
  const selection = req.run_selection ?? null;
  return {
    datasetCaseCount: req.dataset_case_count ?? null,
    selectionMode: selection?.mode ?? null,
    selectedCaseCount: selection?.selected_case_count ?? null,
    sampleSeed: selection?.sample_seed ?? null,
  };
}

/**
 * Human-readable coverage, for the one message a caller ever sees about it.
 * Mirrors how the UI reads a run's coverage, so the two never describe it differently.
 */
function describeCoverage(c: StoredCoverage): string {
  if (c.selectionMode === null) return "coverage unknown";
  const of = `${c.selectedCaseCount} of ${c.datasetCaseCount} cases`;
  if (c.selectionMode === "full") return `full dataset (${c.datasetCaseCount} cases)`;
  const seed = c.sampleSeed != null ? `, seed ${c.sampleSeed}` : "";
  return `${c.selectionMode} ${of}${seed}`;
}

/**
 * Coverage is the run's IMMUTABLE selection identity, so a replay may not quietly
 * redefine it. The idempotent branch below is a lookup-and-echo — every other field on
 * a replay is silently discarded — and for most fields that is merely lossy. For
 * coverage it would be a lie: the caller would be handed a run id for a run that
 * measured a different slice of the dataset than the one it just described, and per the
 * write-only public surface it cannot read the run back to notice.
 *
 * Only a request that ACTUALLY DECLARES coverage can conflict. A request that omits the
 * block asserts nothing, so an older SDK (or any SDK that does not send it) replays
 * exactly as it always has and is never rejected by this check.
 */
function coverageConflict(req: RegisterRunRequest, row: StoredCoverageRow): string | null {
  const incoming = coverageColumns(req);
  const stored = fromRow(row);
  if (incoming.selectionMode === null) return null;
  const same =
    incoming.datasetCaseCount === stored.datasetCaseCount &&
    incoming.selectionMode === stored.selectionMode &&
    incoming.selectedCaseCount === stored.selectedCaseCount &&
    incoming.sampleSeed === stored.sampleSeed;
  if (same) return null;
  return (
    `client_run_id already registered a run with different dataset coverage ` +
    `(stored: ${describeCoverage(stored)}; requested: ${describeCoverage(incoming)}). ` +
    `Coverage is immutable — use a new client_run_id for a differently-scoped run.`
  );
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
  // Resolve `dataset_id` the same lenient way the public GET path does
  // (`resolvePublicDataset`): the project-scoped client id first, then the internal PK
  // as a fallback. A strict client-id-only lookup 404s on an id that `pull_dataset`
  // just accepted (e.g. an internal id copied from the UI), so the two public endpoints
  // must resolve identically. The internal `dataset.id` is threaded through the version,
  // evaluation and run below.
  const dataset = await resolvePublicDataset(tx, projectId, req.dataset_id);
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

  // An evaluation is identified by its stable (project, evaluation_key). Runs of the same
  // evaluation are additive (run #N) and comparable even when the dataset id churns (the
  // SDK may create a fresh Dataset each run); the per-run dataset/version is recorded on the
  // run and comparison flags a mismatch. The key is decoupled from the display name so
  // equivalent Python + TypeScript runs group under one definition. An older SDK omits the
  // key and falls back to the name — reproducing the pre-key behavior (and matching the
  // migration's backfill of key := name). uq_evaluation_project_key makes the identity a DB
  // invariant, so two processes registering the same key (a CI matrix, parallel pytest
  // shards) cannot both insert and split the history: the loser gets P2002 and finds the
  // winner's row on replay.
  const evaluationKey = req.evaluation_key ?? req.evaluation_name;
  const evaluation =
    (await tx.evaluation.findUnique({
      where: { projectId_evaluationKey: { projectId, evaluationKey } },
      select: { id: true },
    })) ??
    (await tx.evaluation.create({
      data: {
        projectId,
        datasetId: dataset.id,
        name: req.evaluation_name,
        evaluationKey,
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
      select: {
        id: true,
        runNumber: true,
        datasetVersionId: true,
        datasetCaseCount: true,
        selectionMode: true,
        selectedCaseCount: true,
        sampleSeed: true,
      },
    });
    if (existing) {
      const conflict = coverageConflict(req, existing);
      if (conflict) return { httpError: { message: conflict, status: 409 } };
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

  // Precedence matters. `case_count` stays first so an SDK that sends it keeps its
  // existing meaning verbatim. `selected_case_count` comes next because it is the count
  // the run actually set out to measure — without it a `--first 20` run against a
  // 500-case version stores 500 and every per-case average reads 25x low. Counting the
  // version is the last resort, and is only right for a run that covers all of it.
  // The contract already refuses a `case_count` that contradicts the selection, so these
  // first two can never disagree.
  const caseCount =
    req.case_count ??
    req.run_selection?.selected_case_count ??
    (await tx.testCase.count({ where: { datasetVersionId: versionId } }));
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
      caseCount,
      // The run's immutable selection identity, written once here. Completion never
      // touches it, so a later `case_count` cannot retroactively redefine what this run
      // set out to measure. All null when the SDK declared nothing → coverage unknown.
      ...coverageColumns(req),
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
