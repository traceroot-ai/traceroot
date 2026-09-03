import { prisma, Role, hasMinRole } from "@traceroot/core";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import {
  DASHBOARD_DESCRIPTION_MAX,
  DASHBOARD_NAME_MAX,
  WIDGET_TITLE_MAX,
  WIDGET_TYPE_MESSAGE,
  WIDGET_TYPES,
  WidgetSpecSchema,
  type WidgetType,
} from "@/features/dashboards/types";
import { parseTraceFeedSpec } from "@/features/dashboards/trace-feed-spec";
import { validateWidgetSpecVocabulary } from "@/features/dashboards/widget-spec-vocabulary";
import { createWidgetWithPlacement } from "@/lib/dashboard-layout";
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
  type: z.enum(WIDGET_TYPES, WIDGET_TYPE_MESSAGE),
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
    return {
      ok: false as const,
      status: 403 as const,
      error: "Not a member of this workspace",
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

/**
 * Room reserved for the collision suffix when a requested name sits at the
 * cap: " (2)" through " (999)" all fit. A project would need close to a
 * thousand same-named dashboards before the search prefix below stopped
 * covering every candidate.
 */
const SUFFIX_ROOM = " (999)".length;

/**
 * The prefix every candidate suffixed name shares with the requested name,
 * so one `startsWith` query fetches every name that could collide with any
 * candidate (the bare name included). For a name comfortably under the cap
 * this is the name itself.
 */
function suffixSearchPrefix(name: string): string {
  return name.slice(0, DASHBOARD_NAME_MAX - SUFFIX_ROOM);
}

/**
 * The lowest-numbered "name (n)", n ≥ 2, that no dashboard in `taken` uses,
 * with the base cut so the suffixed name still fits the cap. The oldest row
 * keeps the bare name — the same convention the write-name-constraints work
 * applies when it deduplicates existing rows. Terminates because `taken` is
 * finite and every candidate is distinct.
 */
function firstFreeSuffixedName(name: string, taken: ReadonlySet<string>): string {
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = name.slice(0, DASHBOARD_NAME_MAX - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
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

    // A same-name dashboard in this project means different things per
    // transport. Over the public API (and the CLI on top of it) the create is
    // idempotent: the existing row comes back as-is, so a retried request
    // can't fan out duplicates. The agent never reuses: a human just
    // confirmed "Create dashboard X" on the chat card, so something must
    // actually be created — it lands under the first free suffixed name
    // ("X (2)", "X (3)", …) and the result says what it was renamed from.
    let finalName = name;
    let renamedFrom: string | undefined;
    if (input.provenance.transport === "agent") {
      const taken = await tx.dashboard.findMany({
        where: { projectId: input.projectId, name: { startsWith: suffixSearchPrefix(name) } },
        select: { name: true },
      });
      const takenNames = new Set(taken.map((row) => row.name));
      if (takenNames.has(name)) {
        finalName = firstFreeSuffixedName(name, takenNames);
        renamedFrom = name;
      }
    } else {
      const existing = await tx.dashboard.findFirst({
        where: { projectId: input.projectId, name },
        select: { id: true, name: true, projectId: true },
      });
      if (existing) {
        return { result: { ok: true, created: false, data: existing } };
      }
    }

    const dashboard = await tx.dashboard.create({
      data: {
        projectId: input.projectId,
        name: finalName,
        description,
        createdBy: input.actorUserId,
      },
      select: { id: true, name: true, projectId: true },
    });
    return {
      result: {
        ok: true,
        created: true,
        data: dashboard,
        ...(renamedFrom === undefined ? {} : { renamedFrom }),
      },
      audit: {
        actorUserId: input.actorUserId,
        operation: "create_dashboard",
        resourceType: "dashboard",
        resourceId: dashboard.id,
        workspaceId: access.workspaceId,
        projectId: input.projectId,
        summary: { name: finalName, ...(renamedFrom === undefined ? {} : { renamedFrom }) },
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
  type: WidgetType;
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
    let spec = parsed.data.spec as Record<string, unknown>;
    // Specs must satisfy the same validation the dashboard renderers use —
    // anything else would store a widget that can only fail at render time.
    // Storing the parsed output (defaults filled, unknown keys handled) means
    // what's stored is exactly what renders.
    if (type === "query") {
      const specParsed = WidgetSpecSchema.safeParse(spec);
      if (!specParsed.success) {
        const issue = specParsed.error.issues[0];
        const path = issue.path.join(".");
        return {
          result: {
            ok: false,
            status: 400,
            error: `spec is not a valid widget spec: ${path ? `${path}: ` : ""}${issue.message}`,
          },
        };
      }
      // Shape-valid is not enough: the fields the spec names must exist in the
      // registry vocabulary, or the widget stores fine and 4xxs forever at
      // query time.
      const vocabulary = validateWidgetSpecVocabulary(specParsed.data);
      if (!vocabulary.ok) {
        return { result: { ok: false, status: 400, error: vocabulary.error } };
      }
      spec = specParsed.data;
    } else {
      const feedParsed = parseTraceFeedSpec(spec);
      if (!feedParsed.ok) {
        return {
          result: {
            ok: false,
            status: 400,
            error: `spec is not a valid trace_feed spec: ${feedParsed.error}`,
          },
        };
      }
      spec = feedParsed.data as unknown as Record<string, unknown>;
    }
    const displayConfig = (parsed.data.displayConfig as Record<string, unknown> | undefined) ?? {};

    // Widgets have no natural key (duplicate titles are legitimate), so this
    // is a strict create — every call adds a widget. Callers pass no layout:
    // a widget with no placement renders through the grid's unpersisted
    // fallback, as a narrow stack down the left edge, so placement is ours.
    const widget = await createWidgetWithPlacement(
      tx,
      { dashboardId: input.dashboardId, type },
      () =>
        tx.widget.create({
          data: {
            dashboardId: input.dashboardId,
            title,
            type,
            spec: spec as object,
            displayConfig: displayConfig as object,
          },
          select: { id: true, dashboardId: true, title: true, type: true },
        }),
    );
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
