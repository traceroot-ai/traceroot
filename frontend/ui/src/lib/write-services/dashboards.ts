import { prisma } from "@traceroot/core";
import { z } from "zod";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";
import {
  DASHBOARD_DESCRIPTION_MAX,
  DASHBOARD_NAME_MAX,
  WIDGET_TITLE_MAX,
} from "@/features/dashboards/types";
import { writeAudit, type AuditEntry } from "./audit";
import { requireProjectMember } from "./project-access";
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
  // Structural check only, matching the cookie widgets route: deep spec
  // validation happens in the query engine at execution time, which is the
  // single source of truth — duplicating its rules here would let the two
  // surfaces drift.
  spec: jsonObject("spec must be a JSON object", true),
  displayConfig: jsonObject("displayConfig must be a JSON object", false),
});

/** What a create transaction returns: the caller's result plus the audit entry
 *  to record once the transaction has committed. Writing the audit row inside
 *  the transaction would let a failed INSERT abort it and discard the resource. */
type TxOutcome<T> = Promise<{ result: ServiceResult<T>; audit?: AuditEntry }>;

export async function createDashboard(input: {
  actorUserId: string;
  projectId: string;
  name: string;
  description?: string | null;
  provenance: Provenance;
}): Promise<ServiceResult<DashboardCreated>> {
  let outcome: Awaited<TxOutcome<DashboardCreated>>;
  try {
    outcome = await prisma.$transaction(async (tx): TxOutcome<DashboardCreated> => {
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
      // returned as-is, so agent/CLI retries can't fan out duplicates. This
      // findFirst is the fast path; uq_dashboard_project_name is the backstop
      // that makes the idempotency atomic under concurrency.
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
  } catch (e) {
    if (!isPrismaKnownError(e, "P2002")) throw e;
    // A concurrent identical create won the race on the unique index.
    // Postgres aborts the losing transaction, so re-read after rollback and
    // answer idempotently, exactly as the fast path would have. The create
    // only ran after validation, so trimming here mirrors the parsed name.
    const raced = await prisma.dashboard.findFirst({
      where: { projectId: input.projectId, name: input.name.trim() },
      select: { id: true, name: true, projectId: true },
    });
    if (!raced) throw e;
    return { ok: true, created: false, data: raced };
  }

  const { result, audit } = outcome;
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
