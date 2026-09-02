import { prisma, Role, hasMinRole } from "@traceroot/core";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import {
  DASHBOARD_DESCRIPTION_MAX,
  DASHBOARD_NAME_MAX,
  WIDGET_TITLE_MAX,
} from "@/features/dashboards/types";
import { writeAudit, type AuditEntry } from "./audit";
import type { Provenance, ServiceResult } from "./types";

export interface DashboardCreated {
  id: string;
  name: string;
  projectId: string;
}

export interface WidgetCreated {
  id: string;
  dashboardId: string;
  title: string;
  type: string;
}

// One message per field regardless of how it fails (missing, wrong type,
// blank, too long), so callers see a deterministic error.
const boundedName = (field: string, max: number) => {
  const message = `${field} must be a non-empty string (max ${max} chars)`;
  return z.string(message).refine((value) => {
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= max;
  }, message);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jsonObject = (message: string, required: boolean) =>
  z.unknown().superRefine((value, ctx) => {
    if (!required && value === undefined) return;
    if (!isPlainObject(value)) ctx.addIssue({ code: "custom", message });
  });

const dashboardSchema = z.object({
  name: boundedName("name", DASHBOARD_NAME_MAX),
  description: z
    .string("description must be a string")
    .max(
      DASHBOARD_DESCRIPTION_MAX,
      `description must be at most ${DASHBOARD_DESCRIPTION_MAX} chars`,
    )
    .nullable()
    .optional(),
});

const widgetSchema = z.object({
  title: boundedName("title", WIDGET_TITLE_MAX),
  type: z.union(
    [z.literal("query"), z.literal("trace_feed")],
    'type must be "query" or "trace_feed"',
  ),
  spec: jsonObject("spec must be a JSON object", true),
  displayConfig: jsonObject("displayConfig must be a JSON object", false),
});

type Tx = Prisma.TransactionClient;

/** What a create transaction returns: the caller's result plus the audit entry
 *  to record once the transaction has committed. Writing the audit row inside
 *  the transaction would let a failed INSERT abort it and discard the resource. */
type TxOutcome<T> = Promise<{ result: ServiceResult<T>; audit?: AuditEntry }>;

// Shared by both writes: the target project must exist (and not be
// soft-deleted) and the actor must hold at least MEMBER in its workspace.
async function requireProjectMember(
  tx: Tx,
  projectId: string,
  actorUserId: string,
): Promise<{ ok: true; workspaceId: string } | { ok: false; status: 403 | 404; error: string }> {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true, deleteTime: true },
  });
  if (!project || project.deleteTime !== null) {
    return { ok: false as const, status: 404 as const, error: "Project not found" };
  }
  const member = await tx.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: project.workspaceId,
        userId: actorUserId,
      },
    },
    select: { role: true },
  });
  if (!member) {
    // Same status and message as a missing project: a 403 here would tell a
    // signed-in outsider that the project id exists in someone else's
    // workspace, which the read paths deliberately never reveal.
    return {
      ok: false as const,
      status: 404 as const,
      error: "Project not found",
    };
  }
  if (!hasMinRole(member.role, Role.MEMBER)) {
    return {
      ok: false as const,
      status: 403 as const,
      error: "Requires MEMBER role or higher",
    };
  }
  return { ok: true as const, workspaceId: project.workspaceId };
}

export async function createDashboard(input: {
  actorUserId: string;
  projectId: string;
  name: string;
  description?: string | null;
  provenance: Provenance;
}): Promise<ServiceResult<DashboardCreated>> {
  const { result, audit } = await prisma.$transaction(async (tx): TxOutcome<DashboardCreated> => {
    const access = await requireProjectMember(tx, input.projectId, input.actorUserId);
    if (!access.ok) return { result: access };

    const parsed = dashboardSchema.safeParse(input);
    if (!parsed.success) {
      return {
        result: { ok: false, status: 400, error: parsed.error.issues[0].message },
      };
    }
    const name = parsed.data.name.trim();
    const description = parsed.data.description ?? null;

    // Idempotent create: a dashboard with the same name in this project is
    // returned as-is, so agent/CLI retries can't fan out duplicates.
    const existing = await tx.dashboard.findFirst({
      where: { projectId: input.projectId, name },
      select: { id: true, name: true, projectId: true },
    });
    if (existing) {
      return { result: { ok: true, created: false, data: existing } };
    }

    const dashboard = await tx.dashboard.create({
      data: {
        projectId: input.projectId,
        name,
        description,
        createdBy: input.actorUserId,
      },
      select: { id: true, name: true, projectId: true },
    });
    return {
      result: { ok: true, created: true, data: dashboard },
      audit: {
        actorUserId: input.actorUserId,
        operation: "create_dashboard",
        resourceType: "dashboard",
        resourceId: dashboard.id,
        workspaceId: access.workspaceId,
        projectId: input.projectId,
        summary: { name },
        transport: input.provenance.transport,
        agentSessionId: input.provenance.agentSessionId ?? null,
      },
    };
  });

  if (audit) {
    await writeAudit(prisma, audit);
  }
  return result;
}

export async function createWidget(input: {
  actorUserId: string;
  projectId: string;
  dashboardId: string;
  title: string;
  type: "query" | "trace_feed";
  spec: Record<string, unknown>;
  displayConfig?: Record<string, unknown>;
  provenance: Provenance;
}): Promise<ServiceResult<WidgetCreated>> {
  const { result, audit } = await prisma.$transaction(async (tx): TxOutcome<WidgetCreated> => {
    const access = await requireProjectMember(tx, input.projectId, input.actorUserId);
    if (!access.ok) return { result: access };

    // Scoped through the project so a dashboard id from another project 404s
    // instead of leaking a cross-project write.
    const dashboard = await tx.dashboard.findFirst({
      where: { id: input.dashboardId, projectId: input.projectId },
      select: { id: true },
    });
    if (!dashboard) {
      return { result: { ok: false, status: 404, error: "Dashboard not found" } };
    }

    const parsed = widgetSchema.safeParse(input);
    if (!parsed.success) {
      return {
        result: { ok: false, status: 400, error: parsed.error.issues[0].message },
      };
    }
    const title = parsed.data.title.trim();
    const { type } = parsed.data;
    const spec = parsed.data.spec as Record<string, unknown>;
    const displayConfig = (parsed.data.displayConfig as Record<string, unknown> | undefined) ?? {};

    // Widgets have no natural key (duplicate titles are legitimate), so this
    // is a strict create — every call adds a widget.
    const widget = await tx.widget.create({
      data: {
        dashboardId: input.dashboardId,
        title,
        type,
        spec: spec as object,
        displayConfig: displayConfig as object,
      },
      select: { id: true, dashboardId: true, title: true, type: true },
    });
    return {
      result: { ok: true, created: true, data: widget },
      audit: {
        actorUserId: input.actorUserId,
        operation: "create_widget",
        resourceType: "widget",
        resourceId: widget.id,
        workspaceId: access.workspaceId,
        projectId: input.projectId,
        summary: { title, type, dashboardId: input.dashboardId },
        transport: input.provenance.transport,
        agentSessionId: input.provenance.agentSessionId ?? null,
      },
    };
  });

  if (audit) {
    await writeAudit(prisma, audit);
  }
  return result;
}
