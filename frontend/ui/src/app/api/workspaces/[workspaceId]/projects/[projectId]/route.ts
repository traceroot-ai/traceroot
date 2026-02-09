import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, Role } from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

const updateProjectSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long").optional(),
  trace_ttl_days: z.number().int().min(1).max(365).nullable().optional(),
});

type RouteParams = { params: Promise<{ workspaceId: string; projectId: string }> };

// GET /api/workspaces/[workspaceId]/projects/[projectId] - Get project details
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { workspaceId, projectId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId);
  if (membershipResult.error) return membershipResult.error;

  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      workspaceId,
      deleteTime: null,
    },
    include: {
      accessKeys: {
        select: {
          id: true,
          keyHint: true,
          name: true,
          expireTime: true,
          lastUseTime: true,
          createTime: true,
        },
        orderBy: { createTime: "desc" },
      },
    },
  });

  if (!project) {
    return errorResponse("Project not found", 404);
  }

  return successResponse({
    id: project.id,
    name: project.name,
    trace_ttl_days: project.traceTtlDays,
    access_keys: project.accessKeys.map((k) => ({
      id: k.id,
      key_hint: k.keyHint,
      name: k.name,
      expire_time: k.expireTime,
      last_use_time: k.lastUseTime,
      create_time: k.createTime,
    })),
    create_time: project.createTime,
    update_time: project.updateTime,
  });
}

// PATCH /api/workspaces/[workspaceId]/projects/[projectId] - Update project (ADMIN+)
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { workspaceId, projectId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId, Role.ADMIN);
  if (membershipResult.error) return membershipResult.error;

  // Check project exists and belongs to workspace
  const existingProject = await prisma.project.findFirst({
    where: {
      id: projectId,
      workspaceId,
      deleteTime: null,
    },
  });

  if (!existingProject) {
    return errorResponse("Project not found", 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const result = updateProjectSchema.safeParse(body);
  if (!result.success) {
    return errorResponse(result.error.issues[0].message, 400);
  }

  const { name, trace_ttl_days } = result.data;

  // Check for duplicate name if name is being changed
  if (name && name !== existingProject.name) {
    const duplicateProject = await prisma.project.findFirst({
      where: {
        workspaceId,
        name,
        deleteTime: null,
        NOT: { id: projectId },
      },
    });

    if (duplicateProject) {
      return errorResponse("A project with this name already exists", 409);
    }
  }

  const project = await prisma.project.update({
    where: { id: projectId },
    data: {
      ...(name !== undefined && { name }),
      ...(trace_ttl_days !== undefined && { traceTtlDays: trace_ttl_days }),
      updateTime: new Date(),
    },
  });

  return successResponse({
    id: project.id,
    name: project.name,
    trace_ttl_days: project.traceTtlDays,
    update_time: project.updateTime,
  });
}

// DELETE /api/workspaces/[workspaceId]/projects/[projectId] - Soft delete project (ADMIN+)
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { workspaceId, projectId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId, Role.ADMIN);
  if (membershipResult.error) return membershipResult.error;

  // Check project exists and belongs to workspace
  const existingProject = await prisma.project.findFirst({
    where: {
      id: projectId,
      workspaceId,
      deleteTime: null,
    },
  });

  if (!existingProject) {
    return errorResponse("Project not found", 404);
  }

  // Soft delete the project
  await prisma.project.update({
    where: { id: projectId },
    data: {
      deleteTime: new Date(),
      updateTime: new Date(),
    },
  });

  return NextResponse.json({ deleted: true }, { status: 200 });
}
