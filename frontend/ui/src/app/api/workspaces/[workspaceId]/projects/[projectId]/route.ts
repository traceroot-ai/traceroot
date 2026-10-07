import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { NextRequest, NextResponse } from "next/server";
import { prisma, Role, DEFAULT_ALERT_WINDOW } from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { readDeleteReason } from "@/lib/route-helpers";
import { deleteProject, updateProject, type ProjectPatch } from "@/lib/write-services/projects";

type RouteParams = { params: Promise<{ workspaceId: string; projectId: string }> };

// GET /api/workspaces/[workspaceId]/projects/[projectId] - Get project details
async function handleGET(request: NextRequest, { params }: RouteParams) {
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
      alertConfig: true,
    },
  });

  if (!project) {
    return errorResponse("Project not found", 404);
  }

  return successResponse({
    id: project.id,
    name: project.name,
    trace_ttl_days: project.traceTtlDays,
    rca_model: project.rcaModel,
    rca_provider: project.rcaProvider,
    rca_source: project.rcaSource,
    alert_emails: project.alertConfig?.emailAddresses ?? [],
    alert_window: project.alertConfig?.alertWindow ?? DEFAULT_ALERT_WINDOW,
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
// A thin adapter over the write service, which owns the validation, the
// tenancy scoping to the path's workspace, the ADMIN floor, the diff and the
// audit row. The body's snake_case keys are mapped onto the service's fields;
// an absent key stays absent, so it is left untouched.
async function handlePATCH(request: NextRequest, { params }: RouteParams) {
  const { workspaceId, projectId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId, Role.ADMIN);
  if (membershipResult.error) return membershipResult.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  const fields = (
    body !== null && typeof body === "object" && !Array.isArray(body) ? body : {}
  ) as Record<string, unknown>;

  const result = await updateProject({
    actorUserId: user.id,
    projectId,
    workspaceId,
    patch: {
      name: fields.name,
      traceTtlDays: fields.trace_ttl_days,
      rcaModel: fields.rca_model,
      rcaProvider: fields.rca_provider,
      rcaSource: fields.rca_source,
      alertEmails: fields.alert_emails,
      alertWindow: fields.alert_window,
    } as ProjectPatch,
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);

  const project = result.data;
  return successResponse({
    id: project.id,
    name: project.name,
    trace_ttl_days: project.traceTtlDays,
    rca_model: project.rcaModel,
    rca_provider: project.rcaProvider,
    rca_source: project.rcaSource,
    alert_emails: project.alertEmails,
    alert_window: project.alertWindow,
    update_time: project.updateTime,
  });
}

// DELETE /api/workspaces/[workspaceId]/projects/[projectId] - Soft delete project (ADMIN+)
async function handleDELETE(request: NextRequest, { params }: RouteParams) {
  const { workspaceId, projectId } = await params;

  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { user } = authResult;

  const membershipResult = await requireWorkspaceMembership(user.id, workspaceId, Role.ADMIN);
  if (membershipResult.error) return membershipResult.error;

  const result = await deleteProject({
    actorUserId: user.id,
    projectId,
    workspaceId,
    reason: await readDeleteReason(request),
    provenance: { transport: "ui" },
  });
  if (!result.ok) return errorResponse(result.error, result.status);

  return NextResponse.json({ deleted: true }, { status: 200 });
}
export const GET = withImpersonationPolicy(handleGET);
export const PATCH = withImpersonationPolicy(handlePATCH);
export const DELETE = withImpersonationPolicy(handleDELETE);
