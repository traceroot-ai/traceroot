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

type RouteParams = { params: Promise<{ workspaceId: string }> };

/**
 * Validates that a match pattern is valid and compatible with the Python worker's regex engine.
 * Strips leading Python inline flags like (?i) for JS testing, and rejects JS-only constructs
 * like (?<name>...) and Unicode property escapes \p{...}.
 */
export function validateWorkerRegex(pattern: string): string | null {
  const stripped = pattern.replace(/^\(\?[imsxADSUXJu-]+\)/, "");

  if (/\(\?<[a-zA-Z_]/.test(stripped)) {
    return "Named groups must use Python syntax (?P<name>...) rather than JS syntax (?<name>...)";
  }

  if (/\\p\{|\\P\{/.test(stripped)) {
    return "Unicode property escapes \\p{...} are not supported in Python regex patterns";
  }

  try {
    new RegExp(stripped);
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid regular expression";
  }

  return null;
}

// Rates are in USD per single token (e.g. 0.000002 for $2.00 / 1M tokens), capped at $1.00/token.
const createPriceSchema = z.object({
  modelName: z.string().trim().min(1, "Model name is required").max(100),
  matchPattern: z.string().trim().max(500).optional(),
  inputPrice: z
    .number()
    .min(0, "Input price must be >= 0")
    .max(1.0, "Input price must be <= 1.0 USD/token"),
  outputPrice: z
    .number()
    .min(0, "Output price must be >= 0")
    .max(1.0, "Output price must be <= 1.0 USD/token"),
  cacheReadPrice: z
    .number()
    .min(0, "Cache read price must be >= 0")
    .max(1.0, "Cache read price must be <= 1.0 USD/token")
    .optional(),
  cacheWritePrice: z
    .number()
    .min(0, "Cache write price must be >= 0")
    .max(1.0, "Cache write price must be <= 1.0 USD/token")
    .optional(),
});

// GET /api/workspaces/[workspaceId]/custom-model-prices
async function handleGET(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;

  const membershipResult = await requireWorkspaceMembership(
    authResult.user.id,
    workspaceId,
    Role.ADMIN,
  );
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
    const regexError = validateWorkerRegex(matchPattern);
    if (regexError) {
      return errorResponse(`Invalid regular expression for matchPattern: ${regexError}`, 400);
    }
  }

  // Case-insensitive duplicate check to match worker lookup semantics
  const existing = await prisma.workspaceModelPrice.findFirst({
    where: {
      workspaceId,
      modelName: {
        equals: modelName,
        mode: "insensitive",
      },
    },
  });

  if (existing) {
    return errorResponse(
      `Custom pricing for model '${modelName}' already exists in this workspace`,
      409,
    );
  }

  try {
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
          cacheWritePrice:
            created.cacheWritePrice !== null ? Number(created.cacheWritePrice) : null,
        },
      },
      201,
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return errorResponse(
        `Custom pricing for model '${modelName}' already exists in this workspace`,
        409,
      );
    }
    throw error;
  }
}

export const GET = withImpersonationPolicy(handleGET);
export const POST = withImpersonationPolicy(handlePOST);
