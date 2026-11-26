import { prisma, Role } from "@traceroot/core";
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/auth-helpers";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";
import {
  labelDescriptionSchema,
  labelValueSchema,
  projectLabelSelect,
  requireLabelProject,
} from "@/lib/labels";
import { withImpersonationPolicy } from "@/lib/support/route-guard";

type RouteParams = { params: Promise<{ projectId: string }> };

const createLabelSchema = z.strictObject({
  name: labelValueSchema,
  description: labelDescriptionSchema.optional(),
});

async function handleGET(_request: Request, { params }: RouteParams) {
  const { projectId } = await params;
  const access = await requireLabelProject(projectId);
  if (access.error) return access.error;

  const labels = await prisma.projectLabel.findMany({
    where: { projectId },
    select: projectLabelSelect,
    orderBy: { name: "asc" },
  });
  return successResponse({ labels });
}

async function handlePOST(request: Request, { params }: RouteParams) {
  const { projectId } = await params;
  const access = await requireLabelProject(projectId, Role.MEMBER);
  if (access.error) return access.error;

  const body = createLabelSchema.safeParse(await request.json().catch(() => undefined));
  if (!body.success)
    return errorResponse(
      "Enter a label name of 1–100 characters and an optional description up to 500 characters",
      400,
    );

  try {
    const label = await prisma.projectLabel.create({
      data: {
        projectId,
        name: body.data.name,
        description: body.data.description || null,
        createdBy: access.user.id,
      },
      select: projectLabelSelect,
    });
    return successResponse({ label }, 201);
  } catch (error) {
    if (isPrismaKnownError(error, "P2002")) return errorResponse("That label already exists", 409);
    throw error;
  }
}

export const GET = withImpersonationPolicy(handleGET);
export const POST = withImpersonationPolicy(handlePOST);
