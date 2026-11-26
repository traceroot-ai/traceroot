import { prisma, Role } from "@traceroot/core";
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";
import { labelDescriptionSchema, projectLabelSelect, requireLabelProject } from "@/lib/labels";
import { withImpersonationPolicy } from "@/lib/support/route-guard";

type RouteParams = { params: Promise<{ projectId: string; labelId: string }> };

const updateLabelSchema = z.strictObject({ description: labelDescriptionSchema });

async function handlePATCH(request: Request, { params }: RouteParams) {
  const { projectId, labelId } = await params;
  const access = await requireLabelProject(projectId, Role.MEMBER);
  if (access.error) return access.error;

  const body = updateLabelSchema.safeParse(await request.json().catch(() => undefined));
  if (!body.success)
    return errorResponse("Only the label description can be changed (up to 500 characters)", 400);

  try {
    const label = await prisma.projectLabel.update({
      where: { id: labelId, projectId },
      data: { description: body.data.description || null },
      select: projectLabelSelect,
    });
    return successResponse({ label });
  } catch (error) {
    if (isPrismaKnownError(error, "P2025")) return errorResponse("Label not found", 404);
    throw error;
  }
}

async function handleDELETE(_request: Request, { params }: RouteParams) {
  const { projectId, labelId } = await params;
  const access = await requireLabelProject(projectId, Role.MEMBER);
  if (access.error) return access.error;

  // The foreign key removes this label's trace and span assignments in the same operation.
  await prisma.projectLabel.deleteMany({ where: { id: labelId, projectId } });
  return new Response(null, { status: 204 });
}

export const PATCH = withImpersonationPolicy(handlePATCH);
export const DELETE = withImpersonationPolicy(handleDELETE);
