import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma, Prisma, Role } from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { DEMO_VIEWER_FORBIDDEN, isDemoViewer } from "@/lib/demo-workspace";
import { validateWorkerRegex } from "../route";

type RouteParams = { params: Promise<{ workspaceId: string; priceId: string }> };

// Rates are in USD per single token (e.g. 0.000002 for $2.00 / 1M tokens), capped at $1.00/token.
const updatePriceSchema = z.object({
  modelName: z.string().trim().min(1, "Model name cannot be empty").max(100).optional(),
  matchPattern: z.string().trim().max(500).nullable().optional(),
  inputPrice: z
    .number()
    .min(0, "Input price must be >= 0")
    .max(1.0, "Input price must be <= 1.0 USD/token")
    .optional(),
  outputPrice: z
    .number()
    .min(0, "Output price must be >= 0")
    .max(1.0, "Output price must be <= 1.0 USD/token")
    .optional(),
  cacheReadPrice: z
    .number()
    .min(0, "Cache read price must be >= 0")
    .max(1.0, "Cache read price must be <= 1.0 USD/token")
    .nullable()
    .optional(),
  cacheWritePrice: z
    .number()
    .min(0, "Cache write price must be >= 0")
    .max(1.0, "Cache write price must be <= 1.0 USD/token")
    .nullable()
    .optional(),
});

// PATCH /api/workspaces/[workspaceId]/custom-model-prices/[priceId]
async function handlePATCH(request: NextRequest, { params }: RouteParams) {
  const { workspaceId, priceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const membershipResult = await requireWorkspaceMembership(
    authResult.user.id,
    workspaceId,
    Role.ADMIN,
  );
  if (membershipResult.error) return membershipResult.error;
  if (isDemoViewer(workspaceId, membershipResult.membership.role)) {
    return errorResponse(DEMO_VIEWER_FORBIDDEN, 403);
  }

  const existing = await prisma.workspaceModelPrice.findFirst({
    where: { id: priceId, workspaceId },
  });
  if (!existing) {
    return errorResponse("Custom model price not found", 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON payload", 400);
  }

  const parsed = updatePriceSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || "Invalid input";
    return errorResponse(msg, 400);
  }

  const { modelName, matchPattern, inputPrice, outputPrice, cacheReadPrice, cacheWritePrice } =
    parsed.data;

  if (matchPattern) {
    const regexError = validateWorkerRegex(matchPattern);
    if (regexError) {
      return errorResponse(`Invalid regular expression for matchPattern: ${regexError}`, 400);
    }
  }

  if (modelName && modelName.toLowerCase() !== existing.modelName.toLowerCase()) {
    const duplicate = await prisma.workspaceModelPrice.findFirst({
      where: {
        workspaceId,
        modelName: {
          equals: modelName,
          mode: "insensitive",
        },
        id: { not: priceId },
      },
    });
    if (duplicate) {
      return errorResponse(
        `Custom pricing for model '${modelName}' already exists in this workspace`,
        409,
      );
    }
  }

  try {
    const updated = await prisma.workspaceModelPrice.update({
      where: { id: priceId },
      data: {
        ...(modelName !== undefined && { modelName }),
        ...(matchPattern !== undefined && { matchPattern }),
        ...(inputPrice !== undefined && { inputPrice }),
        ...(outputPrice !== undefined && { outputPrice }),
        ...(cacheReadPrice !== undefined && { cacheReadPrice }),
        ...(cacheWritePrice !== undefined && { cacheWritePrice }),
      },
    });

    return successResponse({
      price: {
        ...updated,
        inputPrice: Number(updated.inputPrice),
        outputPrice: Number(updated.outputPrice),
        cacheReadPrice: updated.cacheReadPrice !== null ? Number(updated.cacheReadPrice) : null,
        cacheWritePrice: updated.cacheWritePrice !== null ? Number(updated.cacheWritePrice) : null,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return errorResponse(
        `Custom pricing for model '${modelName || existing.modelName}' already exists in this workspace`,
        409,
      );
    }
    throw error;
  }
}

// DELETE /api/workspaces/[workspaceId]/custom-model-prices/[priceId]
async function handleDELETE(request: NextRequest, { params }: RouteParams) {
  const { workspaceId, priceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const membershipResult = await requireWorkspaceMembership(
    authResult.user.id,
    workspaceId,
    Role.ADMIN,
  );
  if (membershipResult.error) return membershipResult.error;
  if (isDemoViewer(workspaceId, membershipResult.membership.role)) {
    return errorResponse(DEMO_VIEWER_FORBIDDEN, 403);
  }

  const existing = await prisma.workspaceModelPrice.findFirst({
    where: { id: priceId, workspaceId },
  });
  if (!existing) {
    return errorResponse("Custom model price not found", 404);
  }

  try {
    await prisma.workspaceModelPrice.delete({
      where: { id: priceId },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return errorResponse("Custom model price not found", 404);
    }
    throw error;
  }

  return successResponse({ deleted: true });
}

export const PATCH = withImpersonationPolicy(handlePATCH);
export const DELETE = withImpersonationPolicy(handleDELETE);
