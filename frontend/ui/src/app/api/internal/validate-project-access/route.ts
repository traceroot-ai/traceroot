import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@traceroot/core";
import { verifyInternalSecret } from "@/lib/auth-helpers";

const validateAccessSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  projectId: z.string().min(1, "Project ID is required"),
});

// POST /api/internal/validate-project-access
// Internal endpoint for Python backend to validate user access to a project
export async function POST(request: NextRequest) {
  // Verify internal secret
  if (!verifyInternalSecret(request)) {
    return NextResponse.json(
      { hasAccess: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { hasAccess: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  const result = validateAccessSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { hasAccess: false, error: result.error.issues[0].message },
      { status: 400 }
    );
  }

  const { userId, projectId } = result.data;

  // Find the project
  const project = await prisma.project.findUnique({
    where: { id: projectId, deleteTime: null },
    select: { id: true, workspaceId: true },
  });

  if (!project) {
    return NextResponse.json({
      hasAccess: false,
      error: "Project not found",
    });
  }

  // Check user's membership in the workspace
  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: project.workspaceId,
        userId: userId,
      },
    },
    select: { role: true },
  });

  if (!membership) {
    return NextResponse.json({
      hasAccess: false,
      error: "No access to this project",
    });
  }

  return NextResponse.json({
    hasAccess: true,
    role: membership.role,
    workspaceId: project.workspaceId,
  });
}
