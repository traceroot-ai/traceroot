import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, PlanType } from "@traceroot/core";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { shouldRefreshLastUseTime } from "./last-use";

const validateKeySchema = z.object({
  keyHash: z.string().min(1, "Key hash is required"),
});

// POST /api/internal/validate-api-key
// Internal endpoint for Python backend to validate access keys
export async function POST(request: NextRequest) {
  // Verify internal secret
  if (!verifyInternalSecret(request)) {
    return NextResponse.json({ valid: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ valid: false, error: "Invalid JSON" }, { status: 400 });
  }

  const result = validateKeySchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { valid: false, error: result.error.issues[0].message },
      { status: 400 },
    );
  }

  const { keyHash } = result.data;

  // Look up access key by hash with workspace billing info
  const accessKey = await prisma.accessKey.findUnique({
    where: { secretHash: keyHash },
    include: {
      project: {
        select: {
          id: true,
          name: true,
          deleteTime: true,
          workspace: {
            select: {
              id: true,
              name: true,
              billingPlan: true,
              ingestionBlocked: true,
            },
          },
        },
      },
    },
  });

  if (!accessKey) {
    return NextResponse.json({ valid: false, error: "Invalid API key" }, { status: 200 });
  }

  // Check if project is deleted
  if (accessKey.project.deleteTime) {
    return NextResponse.json({ valid: false, error: "Project has been deleted" }, { status: 200 });
  }

  // Check if key is expired
  if (accessKey.expireTime && accessKey.expireTime < new Date()) {
    return NextResponse.json({ valid: false, error: "API key has expired" }, { status: 200 });
  }

  // Refresh lastUseTime only when it is stale (see ./last-use), so heavily-used
  // keys don't trigger a write on every validation.
  const now = new Date();
  if (shouldRefreshLastUseTime(accessKey.lastUseTime, now)) {
    await prisma.accessKey.update({
      where: { id: accessKey.id },
      data: { lastUseTime: now },
    });
  }

  const billingPlan = accessKey.project.workspace.billingPlan || PlanType.FREE;

  return NextResponse.json({
    valid: true,
    projectId: accessKey.projectId,
    projectName: accessKey.project.name,
    workspaceId: accessKey.project.workspace.id,
    workspaceName: accessKey.project.workspace.name,
    keyName: accessKey.name ?? null,
    keyHint: accessKey.keyHint,
    // Reported so the Python service can enforce scope on its own routes, which
    // it now does: it narrows this value the same way `parseScope` does and
    // refuses an under-scoped key with the same 403 and the same message as
    // `requireApiKeyProject`, so a caller cannot tell which layer refused it.
    // Its key-management routes require `admin` and refuse anything less before
    // forwarding to the routes here, which require the same scope and still
    // re-validate — two checks, not a relocated one. Every other route it
    // exposes that accepts an API key at all stays reachable with an `ingest`
    // one; the rest take a user credential only and refuse a key outright,
    // before scope is ever consulted. Omitting this field (an older deployment
    // of this app) is read there as the narrow scope, never as full access, so a
    // key-management call is refused during a rollout rather than let through.
    scope: accessKey.scope,
    billingPlan,
    ingestionBlocked: accessKey.project.workspace.ingestionBlocked,
    expiresAt: accessKey.expireTime?.toISOString() ?? null,
  });
}
