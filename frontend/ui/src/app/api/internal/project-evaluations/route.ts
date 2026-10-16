import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import {
  getDatasetDetail,
  getDatasetVersionPage,
  listDatasetsPage,
  listDatasetVersionsPage,
} from "@/lib/eval/dataset-read";
import { listEvaluationRunsPage, listEvaluationsPage } from "@/lib/eval/evaluation-read";
import { evalReadResponse } from "@/lib/eval/read-result";
import { readRunSummary } from "@/lib/eval/run-read";

const runRead = z.object({
  read: z.literal("run"),
  // The string-typed error covers missing/wrong-type input too, so the surfaced message is
  // deterministic whether the field is absent or empty.
  projectId: z.string("projectId is required").min(1, "projectId is required"),
  runId: z.string("runId is required").min(1, "runId is required"),
});

const projectId = z.string("projectId is required").min(1, "projectId is required");
const datasetId = z.string("datasetId is required").min(1, "datasetId is required");
// Page sizes are clamped by the read itself, like the public routes' backstop, so only the
// type is checked here.
const limit = z.number("limit must be a number").int("limit must be an integer").optional();
const cursor = z.string("cursor must be a string").min(1, "cursor must be a string").optional();

const datasetsRead = z.object({
  read: z.literal("datasets"),
  projectId,
  limit,
  cursor,
  name: z.string("name must be a string").min(1, "name must be a string").optional(),
});
const datasetRead = z.object({ read: z.literal("dataset"), projectId, datasetId });
const datasetVersionsRead = z.object({
  read: z.literal("dataset_versions"),
  projectId,
  datasetId,
  limit,
  cursor,
});
const datasetVersionRead = z.object({
  read: z.literal("dataset_version"),
  projectId,
  versionId: z.string("versionId is required").min(1, "versionId is required"),
  limit,
  cursor,
});

const evaluationsRead = z.object({
  read: z.literal("evaluations"),
  projectId,
  limit,
  cursor,
  name: z.string("name must be a string").min(1, "name must be a string").optional(),
});
const evaluationRunsRead = z.object({
  read: z.literal("evaluation_runs"),
  projectId,
  limit,
  cursor,
  evaluationId: z
    .string("evaluationId must be a string")
    .min(1, "evaluationId must be a string")
    .optional(),
  // Checked against the published statuses by the read itself, the same backstop as limit.
  status: z.string("status must be a string").min(1, "status must be a string").optional(),
});

// One route for the evaluation catalog's reads, told apart by `read`.
const projectEvaluationsSchema = z.discriminatedUnion("read", [
  runRead,
  datasetsRead,
  datasetRead,
  datasetVersionsRead,
  datasetVersionRead,
  evaluationsRead,
  evaluationRunsRead,
]);

// POST /api/internal/project-evaluations
//
// Serves the evaluation reads (`get_evaluation_run`, the two listing reads and the four
// dataset reads) given a
// projectId the caller has ALREADY resolved from an authenticated credential. Used by the
// Python backend for the public reads; trust is the X-Internal-Secret plus the backend's
// verified project scope. Every lookup is scoped through the project id, so another
// project's run simply isn't found (404), and the retention window is resolved from the
// project's own workspace inside the read, never from the caller. Never log ids.
export async function POST(request: NextRequest) {
  if (!verifyInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = projectEvaluationsSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: result.error.issues[0].message }, { status: 400 });
  }

  const read = result.data;
  switch (read.read) {
    case "run":
      return evalReadResponse(
        await readRunSummary({ projectId: read.projectId, runId: read.runId }),
      );
    case "datasets":
      return evalReadResponse(
        await listDatasetsPage({
          projectId: read.projectId,
          limit: read.limit,
          cursor: read.cursor ?? null,
          name: read.name ?? null,
        }),
      );
    case "dataset":
      return evalReadResponse(
        await getDatasetDetail({ projectId: read.projectId, datasetId: read.datasetId }),
      );
    case "dataset_versions":
      return evalReadResponse(
        await listDatasetVersionsPage({
          projectId: read.projectId,
          datasetId: read.datasetId,
          limit: read.limit,
          cursor: read.cursor ?? null,
        }),
      );
    case "dataset_version":
      return evalReadResponse(
        await getDatasetVersionPage({
          projectId: read.projectId,
          versionId: read.versionId,
          limit: read.limit,
          cursor: read.cursor ?? null,
        }),
      );
    case "evaluations":
      return evalReadResponse(
        await listEvaluationsPage({
          projectId: read.projectId,
          limit: read.limit,
          cursor: read.cursor ?? null,
          name: read.name ?? null,
        }),
      );
    case "evaluation_runs":
      return evalReadResponse(
        await listEvaluationRunsPage({
          projectId: read.projectId,
          limit: read.limit,
          cursor: read.cursor ?? null,
          evaluationId: read.evaluationId ?? null,
          status: read.status ?? null,
        }),
      );
  }
}
