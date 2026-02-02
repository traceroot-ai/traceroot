import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyInternalSecret } from "@/lib/auth-helpers";

const validateKeySchema = z.object({
  keyHash: z.string().min(1, "Key hash is required"),
});

// POST /api/internal/validate-api-key
// Internal endpoint for Python backend to validate access keys
export async function POST(request: NextRequest) {
  // Verify internal secret
  if (!verifyInternalSecret(request)) {
    return NextResponse.json(
      { valid: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { valid: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  const result = validateKeySchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { valid: false, error: result.error.issues[0].message },
      { status: 400 }
    );
  }

  const { keyHash } = result.data;

  // Look up access key by hash
  const accessKey = await prisma.accessKey.findUnique({
    where: { secretHash: keyHash },
    include: {
      project: {
        select: {
          id: true,
          deleteTime: true,
        },
      },
    },
  });

  if (!accessKey) {
    return NextResponse.json(
      { valid: false, error: "Invalid API key" },
      { status: 200 }
    );
  }

  // Check if project is deleted
  if (accessKey.project.deleteTime) {
    return NextResponse.json(
      { valid: false, error: "Project has been deleted" },
      { status: 200 }
    );
  }

  // Check if key is expired
  if (accessKey.expireTime && accessKey.expireTime < new Date()) {
    return NextResponse.json(
      { valid: false, error: "API key has expired" },
      { status: 200 }
    );
  }

  // Update lastUseTime
  await prisma.accessKey.update({
    where: { id: accessKey.id },
    data: { lastUseTime: new Date() },
  });

  return NextResponse.json({
    valid: true,
    projectId: accessKey.projectId,
    expiresAt: accessKey.expireTime?.toISOString() ?? null,
  });
}
