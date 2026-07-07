import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  prisma,
  Role,
  isAlertWindow,
  DEFAULT_ALERT_WINDOW,
  SYSTEM_MODELS,
  ADAPTER_MODELS,
  ModelSource,
} from "@traceroot/core";
import type { LLMAdapter } from "@traceroot/core";
import {
  requireAuth,
  requireWorkspaceMembership,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";

const updateProjectSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long").optional(),
  trace_ttl_days: z.number().int().min(1).max(365).nullable().optional(),
  rca_model: z.string().min(1).max(200).nullable().optional(),
  rca_provider: z.string().min(1).max(200).nullable().optional(),
  rca_source: z.string().min(1).max(200).nullable().optional(),
  alert_emails: z.array(z.string().email().max(254)).max(50).optional(),
  alert_window: z.string().refine(isAlertWindow, "Invalid alert window").optional(),
});

type RouteParams = { params: Promise<{ workspaceId: string; projectId: string }> };

type RcaModelSelection = {
  rcaModel: string | null;
  rcaProvider: string | null;
  rcaSource: string | null;
};

function isSupportedByokModel(adapter: string, model: string): boolean {
  const catalog = ADAPTER_MODELS[adapter as LLMAdapter];
  return !catalog || catalog.some((candidate) => candidate.id === model);
}

async function validateRcaModelSelection(
  workspaceId: string,
  selection: RcaModelSelection,
): Promise<RcaModelSelection | { error: string }> {
  const rcaModel = selection.rcaModel?.trim() || null;
  const rcaProvider = selection.rcaProvider?.trim() || null;
  const rcaSource = selection.rcaSource?.trim() || null;

  if (!rcaModel && !rcaProvider && !rcaSource) {
    return { rcaModel: null, rcaProvider: null, rcaSource: null };
  }

  if (!rcaModel || !rcaProvider || !rcaSource) {
    return { error: "RCA model, provider, and source must be provided together" };
  }

  if (rcaSource === ModelSource.SYSTEM) {
    const normalizedProvider = rcaProvider.toLowerCase();
    const systemProvider = SYSTEM_MODELS.find(
      (candidate) =>
        candidate.provider.toLowerCase() === normalizedProvider ||
        candidate.piAIProvider.toLowerCase() === normalizedProvider,
    );

    if (!systemProvider || !process.env[systemProvider.envVar]) {
      return { error: "Selected system provider is not available for this workspace" };
    }

    if (!systemProvider.models.some((candidate) => candidate.id === rcaModel)) {
      return { error: "Selected system model is not available for this workspace" };
    }

    return {
      rcaModel,
      rcaProvider: systemProvider.provider,
      rcaSource: ModelSource.SYSTEM,
    };
  }

  if (rcaSource !== ModelSource.BYOK) {
    return { error: "RCA model source must be system or byok" };
  }

  const byokProvider = await prisma.modelProvider.findFirst({
    where: { workspaceId, provider: rcaProvider, enabled: true },
    select: { provider: true, adapter: true, customModels: true },
  });

  if (!byokProvider) {
    return { error: "Selected BYOK provider is not available for this workspace" };
  }

  const configuredModels = byokProvider.customModels.map((id) => id.trim()).filter(Boolean);
  if (!configuredModels.includes(rcaModel)) {
    return { error: "Selected BYOK model is not configured for this provider" };
  }

  if (!isSupportedByokModel(byokProvider.adapter, rcaModel)) {
    return { error: "Selected BYOK model is not supported by Traceroot" };
  }

  return {
    rcaModel,
    rcaProvider: byokProvider.provider,
    rcaSource: ModelSource.BYOK,
  };
}

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

  const { name, trace_ttl_days, rca_model, rca_provider, rca_source, alert_emails, alert_window } =
    result.data;

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

  const nextRcaSelection = await validateRcaModelSelection(workspaceId, {
    rcaModel: rca_model !== undefined ? rca_model : existingProject.rcaModel,
    rcaProvider: rca_provider !== undefined ? rca_provider : existingProject.rcaProvider,
    rcaSource: rca_source !== undefined ? rca_source : existingProject.rcaSource,
  });
  if ("error" in nextRcaSelection) {
    return errorResponse(nextRcaSelection.error, 400);
  }

  const project = await prisma.project.update({
    where: { id: projectId },
    data: {
      ...(name !== undefined && { name }),
      ...(trace_ttl_days !== undefined && { traceTtlDays: trace_ttl_days }),
      ...(rca_model !== undefined && { rcaModel: nextRcaSelection.rcaModel }),
      ...(rca_provider !== undefined && { rcaProvider: nextRcaSelection.rcaProvider }),
      ...(rca_source !== undefined && { rcaSource: nextRcaSelection.rcaSource }),
      ...((alert_emails !== undefined || alert_window !== undefined) && {
        alertConfig: {
          upsert: {
            create: {
              ...(alert_emails !== undefined && { emailAddresses: alert_emails }),
              ...(alert_window !== undefined && { alertWindow: alert_window }),
            },
            update: {
              ...(alert_emails !== undefined && { emailAddresses: alert_emails }),
              ...(alert_window !== undefined && { alertWindow: alert_window }),
            },
          },
        },
      }),
      updateTime: new Date(),
    },
    include: { alertConfig: true },
  });

  return successResponse({
    id: project.id,
    name: project.name,
    trace_ttl_days: project.traceTtlDays,
    rca_model: project.rcaModel,
    rca_provider: project.rcaProvider,
    rca_source: project.rcaSource,
    alert_emails: project.alertConfig?.emailAddresses ?? [],
    alert_window: project.alertConfig?.alertWindow ?? DEFAULT_ALERT_WINDOW,
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
