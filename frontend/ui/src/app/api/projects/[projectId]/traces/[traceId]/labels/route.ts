import { PlanType, prisma, Role } from "@traceroot/core";
import { z } from "zod";
import { env } from "@/env";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";
import { labelTargetIdSchema, labelValueSchema, requireLabelProject } from "@/lib/labels";
import { withImpersonationPolicy } from "@/lib/support/route-guard";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const TARGET_LOOKUP_TIMEOUT_MS = 10_000;

type RouteParams = { params: Promise<{ projectId: string; traceId: string }> };

const assignmentSchema = z.strictObject({ value: labelValueSchema });

async function handleLabels(request: Request, { params }: RouteParams) {
  const { projectId, traceId } = await params;
  const readOnly = request.method === "GET";
  const access = readOnly
    ? await requireLabelProject(projectId)
    : await requireLabelProject(projectId, Role.MEMBER);
  if (access.error) return access.error;

  const spanId = new URL(request.url).searchParams.get("spanId");
  if (
    !labelTargetIdSchema.safeParse(traceId).success ||
    (spanId !== null && !labelTargetIdSchema.safeParse(spanId).success)
  ) {
    return errorResponse("Invalid trace or span ID", 400);
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: access.project.workspaceId },
    select: { billingPlan: true },
  });
  const targetParams = new URLSearchParams({
    projectId,
    traceId,
    billingPlan: workspace?.billingPlan || PlanType.FREE,
  });
  if (spanId !== null) targetParams.set("spanId", spanId);
  const validated = await fetch(`${BACKEND_URL}/api/v1/internal/label-target?${targetParams}`, {
    headers: { "X-Internal-Secret": env.INTERNAL_API_SECRET },
    cache: "no-store",
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(TARGET_LOOKUP_TIMEOUT_MS)]),
  }).catch(() => null);
  if (validated?.status === 404) return errorResponse("Trace or span not found", 404);
  if (validated?.status === 403) {
    const body = await validated.json().catch(() => null);
    const detail: unknown = body?.detail;
    if (typeof detail === "object" && detail !== null && "retention_days" in detail) {
      return errorResponse("Trace is outside its access window", 403);
    }
  }
  if (validated?.status !== 204) return errorResponse("Unable to verify the trace or span", 502);

  const target = { projectId, traceId, spanId: spanId ?? "" };
  const authorId = access.user.id;
  const read = prisma.label.findMany({
    where: target,
    select: { value: true, authorId: true },
    orderBy: { value: "asc" },
  });
  let assignments;
  if (readOnly) {
    assignments = await read;
  } else {
    const body = assignmentSchema.safeParse(await request.json().catch(() => undefined));
    if (!body.success) return errorResponse("A project label is required", 400);

    const assignment = { ...target, value: body.data.value, authorId, source: "HUMAN" as const };
    const write =
      request.method === "PUT"
        ? prisma.label.createMany({ data: [assignment], skipDuplicates: true })
        : prisma.label.deleteMany({ where: assignment });
    try {
      [, assignments] = await prisma.$transaction([write, read]);
    } catch (error) {
      if (isPrismaKnownError(error, "P2003")) return errorResponse("Project label not found", 404);
      throw error;
    }
  }

  return successResponse({
    values: [...new Set(assignments.map(({ value }) => value))],
    appliedByMe: assignments
      .filter((assignment) => assignment.authorId === authorId)
      .map(({ value }) => value),
  });
}

export const GET = withImpersonationPolicy(handleLabels);
export const PUT = withImpersonationPolicy(handleLabels);
export const DELETE = withImpersonationPolicy(handleLabels);
