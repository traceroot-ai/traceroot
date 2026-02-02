import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

const createProjectSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
  trace_ttl_days: z.number().int().min(1).max(365).optional(),
});

type RouteParams = { params: Promise<{ workspaceId: string }> };

// GET /api/workspaces/[workspaceId]/projects - List projects in workspace
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId);
  if (membershipResult.error) return membershipResult.error;

  // Check for includeDeleted query param
  const url = new URL(request.url);
  const includeDeleted = url.searchParams.get("includeDeleted") === "true";

  const projects = await prisma.project.findMany({
    where: {
      workspaceId,
      ...(includeDeleted ? {} : { deleteTime: null }),
    },
    include: {
      _count: { select: { accessKeys: true } },
    },
    orderBy: { name: "asc" },
  });

  return successResponse({
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      trace_ttl_days: p.traceTtlDays,
      access_key_count: p._count.accessKeys,
      delete_time: p.deleteTime,
      create_time: p.createTime,
      update_time: p.updateTime,
    })),
  });
}

// POST /api/workspaces/[workspaceId]/projects - Create a new project (MEMBER+)
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId, "MEMBER");
  if (membershipResult.error) return membershipResult.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const result = createProjectSchema.safeParse(body);
  if (!result.success) {
    return errorResponse(result.error.issues[0].message, 400);
  }

  const { name, trace_ttl_days } = result.data;

  // Check for duplicate name in workspace
  const existingProject = await prisma.project.findFirst({
    where: {
      workspaceId,
      name,
      deleteTime: null,
    },
  });

  if (existingProject) {
    return errorResponse("A project with this name already exists", 409);
  }

  const projectId = crypto.randomUUID();

  const project = await prisma.project.create({
    data: {
      id: projectId,
      workspaceId,
      name,
      traceTtlDays: trace_ttl_days ?? null,
    },
  });

  return NextResponse.json(
    {
      id: project.id,
      name: project.name,
      trace_ttl_days: project.traceTtlDays,
      access_key_count: 0,
      create_time: project.createTime,
    },
    { status: 201 }
  );
}
