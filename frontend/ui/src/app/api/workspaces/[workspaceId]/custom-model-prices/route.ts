import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma, Role } from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { DEMO_VIEWER_FORBIDDEN, isDemoViewer } from "@/lib/demo-workspace";

type RouteParams = { params: Promise<{ workspaceId: string }> };

const createPriceSchema = z.object({
  modelName: z.string().trim().min(1, "Model name is required").max(100),
  matchPattern: z.string().trim().max(500).optional(),
  inputPrice: z.number().min(0, "Input price must be >= 0").max(1000),
  outputPrice: z.number().min(0, "Output price must be >= 0").max(1000),
  cacheReadPrice: z.number().min(0, "Cache read price must be >= 0").max(1000).optional(),
  cacheWritePrice: z.number().min(0, "Cache write price must be >= 0").max(1000).optional(),
});

// GET /api/workspaces/[workspaceId]/custom-model-prices
async function handleGET(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const membershipResult = await requireWorkspaceMembership(authResult.user.id, workspaceId);
  if (membershipResult.error) return membershipResult.error;

  const prices = await prisma.workspaceModelPrice.findMany({
    where: { workspaceId },
    select: {
      id: true,
      workspaceId: true,
      modelName: true,
      matchPattern: true,
      inputPrice: true,
      outputPrice: true,
      cacheReadPrice: true,
      cacheWritePrice: true,
      createdBy: true,
      createTime: true,
      updateTime: true,
    },
    orderBy: { modelName: "asc" },
  });

  const formatted = prices.map((p) => ({
    ...p,
    inputPrice: Number(p.inputPrice),
    outputPrice: Number(p.outputPrice),
    cacheReadPrice: p.cacheReadPrice !== null ? Number(p.cacheReadPrice) : null,
    cacheWritePrice: p.cacheWritePrice !== null ? Number(p.cacheWritePrice) : null,
  }));

  return successResponse({ prices: formatted });
}

// POST /api/workspaces/[workspaceId]/custom-model-prices
async function handlePOST(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON payload", 400);
  }

  const parsed = createPriceSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || "Invalid input";
    return errorResponse(msg, 400);
  }

  const { modelName, matchPattern, inputPrice, outputPrice, cacheReadPrice, cacheWritePrice } =
    parsed.data;

  if (matchPattern) {
    try {
      new RegExp(matchPattern);
    } catch {
      return errorResponse("Invalid regular expression for matchPattern", 400);
    }
  }

  const existing = await prisma.workspaceModelPrice.findUnique({
    where: {
      workspaceId_modelName: {
        workspaceId,
        modelName,
      },
    },
  });

  if (existing) {
    return errorResponse(
      `Custom pricing for model '${modelName}' already exists in this workspace`,
      409,
    );
  }

  const created = await prisma.workspaceModelPrice.create({
    data: {
      workspaceId,
      modelName,
      matchPattern: matchPattern || null,
      inputPrice,
      outputPrice,
      cacheReadPrice: cacheReadPrice ?? null,
      cacheWritePrice: cacheWritePrice ?? null,
      createdBy: authResult.user.id,
    },
  });

  return successResponse(
    {
      price: {
        ...created,
        inputPrice: Number(created.inputPrice),
        outputPrice: Number(created.outputPrice),
        cacheReadPrice: created.cacheReadPrice !== null ? Number(created.cacheReadPrice) : null,
        cacheWritePrice: created.cacheWritePrice !== null ? Number(created.cacheWritePrice) : null,
      },
    },
    201,
  );
}

export const GET = withImpersonationPolicy(handleGET);
export const POST = withImpersonationPolicy(handlePOST);
