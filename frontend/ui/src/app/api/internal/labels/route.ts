import { prisma } from "@traceroot/core";
import { z } from "zod";
import { errorResponse, successResponse, verifyInternalSecret } from "@/lib/auth-helpers";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";
import { labelTargetIdSchema, labelValueSchema } from "@/lib/labels";

// Match the trace reader's existing trace_ids input limit.
const MAX_TRACE_IDS = 100;

const filterSchema = z.strictObject({ projectId: labelTargetIdSchema, value: labelValueSchema });
const sdkAssignmentSchema = filterSchema.extend({
  traceId: labelTargetIdSchema,
  spanId: labelTargetIdSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(128),
});

export async function GET(request: Request) {
  if (!verifyInternalSecret(request)) return errorResponse("Unauthorized", 401);

  const { searchParams } = new URL(request.url);
  const query = filterSchema.safeParse({
    projectId: searchParams.get("projectId"),
    value: searchParams.get("value"),
  });
  if (!query.success) return errorResponse("A project ID and label are required", 400);

  const traces = await prisma.label.groupBy({
    by: ["traceId"],
    where: query.data,
    orderBy: { traceId: "asc" },
    take: MAX_TRACE_IDS + 1,
  });
  return successResponse({
    traceIds: traces.slice(0, MAX_TRACE_IDS).map(({ traceId }) => traceId),
    overflow: traces.length > MAX_TRACE_IDS,
  });
}

// The public gateway verifies the project key and target before forwarding.
export async function POST(request: Request) {
  if (!verifyInternalSecret(request)) return errorResponse("Unauthorized", 401);

  const body = sdkAssignmentSchema.safeParse(await request.json().catch(() => undefined));
  if (!body.success) return errorResponse("Invalid SDK label payload", 400);

  const { projectId, traceId, spanId = "", value, idempotencyKey } = body.data;
  try {
    const id = await prisma.$transaction(async (tx) => {
      // Claim the key before touching the catalog so retries still work after deletion.
      const receipt = await tx.sdkLabelReceipt.create({
        data: { projectId, traceId, spanId, value, idempotencyKey },
        select: { labelId: true },
      });
      await tx.label.create({
        data: { id: receipt.labelId, projectId, traceId, spanId, value, source: "SDK" },
        select: { id: true },
      });
      return receipt.labelId;
    });
    return successResponse({ id });
  } catch (error) {
    if (isPrismaKnownError(error, "P2003")) return errorResponse("Project label not found", 404);
    if (!isPrismaKnownError(error, "P2002")) throw error;

    const existing = await prisma.sdkLabelReceipt.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
      select: { labelId: true, traceId: true, spanId: true, value: true },
    });
    if (!existing) throw error;
    if (existing.traceId !== traceId || existing.spanId !== spanId || existing.value !== value) {
      return errorResponse("That idempotency key was used for a different label assignment", 409);
    }
    return successResponse({ id: existing.labelId });
  }
}
