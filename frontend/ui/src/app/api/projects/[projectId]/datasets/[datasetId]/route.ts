import { NextRequest } from "next/server";
import { prisma, Role, UpdateDatasetRequestSchema } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { displayJsonValue } from "@/lib/eval/json-value";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";
import { TEST_CASE_ORDER } from "@/lib/eval/versions";

type RouteParams = { params: Promise<{ projectId: string; datasetId: string }> };

// GET — dataset detail: a chosen version (default current), its test cases, and
// the version list. `?version_id=` views an older immutable snapshot; an unknown
// or omitted id falls back to the current version.
export async function GET(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, datasetId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const dataset = await prisma.dataset.findFirst({
    where: { id: datasetId, projectId },
    include: {
      versions: { orderBy: { versionNumber: "desc" } },
    },
  });
  if (!dataset) return errorResponse("Dataset not found", 404);

  // The requested version, if it belongs to this dataset; else the current one.
  const requestedVersionId = req.nextUrl.searchParams.get("version_id");
  const selectedVersion =
    (requestedVersionId ? dataset.versions.find((v) => v.id === requestedVersionId) : undefined) ??
    dataset.versions.find((v) => v.id === dataset.currentVersionId) ??
    null;

  // Insertion order — the order cases were added, matching the run results table (and
  // the SDK array). `TEST_CASE_ORDER` sorts by `position` first, so cases no longer come
  // back in content-addressed (hashed) `testCaseId` order; the order is total and stable
  // across two loads of the same version.
  const testCases = selectedVersion
    ? await prisma.testCase.findMany({
        where: { datasetVersionId: selectedVersion.id },
        orderBy: TEST_CASE_ORDER,
      })
    : [];
  const currentVersion = dataset.versions.find((v) => v.id === dataset.currentVersionId) ?? null;

  // Present input/expected as human-readable text for the UI: a genuine string as-is,
  // structured values (from an SDK push) as pretty JSON — never a bare quoted string.
  const presentedCases = testCases.map((t) => ({
    ...t,
    input: displayJsonValue(t.input),
    expected: t.expected === null ? null : displayJsonValue(t.expected),
  }));

  return successResponse({
    dataset,
    currentVersion,
    selectedVersion,
    isCurrentVersion: selectedVersion?.id === dataset.currentVersionId,
    testCases: presentedCases,
    versions: dataset.versions,
  });
}

// PATCH — update editable dataset metadata (not its snapshots).
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, datasetId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId, Role.MEMBER);
  if (accessResult.error) return accessResult.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  const parsed = UpdateDatasetRequestSchema.safeParse(body);
  if (!parsed.success) return errorResponse(parsed.error.issues[0].message, 400);

  const existing = await prisma.dataset.findFirst({
    where: { id: datasetId, projectId },
    select: { id: true, key: true, name: true, clientDatasetId: true },
  });
  if (!existing) return errorResponse("Dataset not found", 404);

  // A dataset's name is its human identity: renaming onto a name another dataset in the
  // project already uses would deduplicate them, so deny it (case-insensitive). Excludes
  // this dataset itself, so keeping (or re-casing) its own name is allowed.
  if (parsed.data.name !== undefined) {
    const clash = await prisma.dataset.findFirst({
      where: {
        projectId,
        clientDatasetId: null, // UI-scoped, matching the partial unique index
        id: { not: datasetId },
        name: { equals: parsed.data.name, mode: "insensitive" as const },
      },
      select: { name: true },
    });
    if (clash) {
      return errorResponse(
        `A dataset named "${clash.name}" already exists in this project. Pick a different name.`,
        409,
      );
    }
  }

  // Freeze identity before a rename changes it: a legacy UI-only dataset with a null key
  // derives its content-addressed case ids from `key ?? name` (see resolveDatasetKey), so
  // renaming it would silently shift every future case id away from an SDK author who
  // addressed the dataset by its ORIGINAL name. Backfill `key` to the current name at the
  // moment of the rename so the id pre-image stays pinned to that name. Restricted to a
  // legacy UI-only dataset (null key AND null clientDatasetId): a public SDK dataset can
  // carry a null key alongside a non-null clientDatasetId (the public upsert permits an
  // omitted key and later supplies `c.key`), and writing the display name as its key would
  // freeze the WRONG hash pre-image and diverge the UI case ids from the SDK's real key.
  const backfillKey =
    parsed.data.name !== undefined && existing.key === null && existing.clientDatasetId === null;

  try {
    const dataset = await prisma.dataset.update({
      where: { id: datasetId },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(backfillKey ? { key: existing.name } : {}),
      },
    });
    return successResponse({ dataset });
  } catch (e) {
    // A rename racing a concurrent create/rename to the same name loses to the partial
    // unique index (uq_dataset_project_lower_name_ui); surface the same 409 as the pre-check.
    if (parsed.data.name !== undefined && isPrismaKnownError(e, "P2002")) {
      return errorResponse(
        `A dataset named "${parsed.data.name}" already exists in this project. Pick a different name.`,
        409,
      );
    }
    throw e;
  }
}

// DELETE — remove the dataset and cascade its versions/test cases.
//
// Refused once anything has been evaluated: a run pins a dataset_version_id, and
// that snapshot must stay byte-stable and pullable for as long as the run exists.
// The database enforces it (evaluation_runs → dataset_versions is NoAction, so the
// cascade cannot take a pinned version with it); this pre-check exists so the
// answer is a deliberate 409 rather than a foreign-key error surfacing as a 500.
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, datasetId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId, Role.MEMBER);
  if (accessResult.error) return accessResult.error;

  const existing = await prisma.dataset.findFirst({
    where: { id: datasetId, projectId },
    select: { id: true },
  });
  if (!existing) return errorResponse("Dataset not found", 404);

  const runCount = await prisma.evaluationRun.count({ where: { datasetId, projectId } });
  if (runCount > 0) {
    return errorResponse("Cannot delete a dataset that has evaluation runs", 409);
  }

  try {
    await prisma.dataset.delete({ where: { id: datasetId } });
  } catch (err) {
    // A run registered between the count and the delete: the FK still holds the
    // line, and the caller gets the same 409 instead of an unexplained 500.
    if (isPrismaKnownError(err, "P2003") || isPrismaKnownError(err, "P2014")) {
      return errorResponse("Cannot delete a dataset that has evaluation runs", 409);
    }
    throw err;
  }
  return successResponse({ deleted: true });
}
