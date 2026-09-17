/**
 * Dashboard and widget writes for every surface: the public API proxy, the
 * agent binding and the web app's cookie routes all land here.
 *
 * `updateDashboard` and `updateWidget` are PATCH semantics: a field the
 * caller leaves out is untouched, an explicit null clears the fields that
 * allow it. Each reads the row, diffs the patch against it and writes only
 * when something differs. A future `replaceDashboard` / `replaceWidget`
 * (PUT) would validate a full body with the create schema and call the same
 * diff-and-write core; the core is shared on purpose.
 */
import type { Dashboard, Widget } from "@prisma/client";
import { prisma } from "@traceroot/core";
import { z } from "zod";
import { isPrismaKnownError } from "@/lib/eval/prisma-errors";
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
import {
  createWidgetWithPlacement,
  deleteWidgetWithPlacement,
  lockDashboardLayout,
} from "@/lib/dashboard-layout";
import { isPlainObject } from "@/lib/is-plain-object";
import { writeAudit, type AuditEntry } from "./audit";
import { requireProjectMember } from "./project-access";
import type { DeleteResult, EditOutcome, Provenance, ServiceResult, UpdateResult } from "./types";
import { NO_FIELDS_MESSAGE, definedKeys, diffPatch, validateDeleteReason } from "./update-support";

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
  // Shape check only here (a JSON object, matching the cookie widgets route);
  // the deep check against the canonical widget spec schema follows in
  // createWidget, so the create paths share one rule set instead of each
  // re-deriving the query engine's.
  spec: jsonObject("spec must be a JSON object", true),
  displayConfig: jsonObject("displayConfig must be a JSON object", false),
});

/**
 * A widget spec must satisfy the same validation the dashboard renderers use;
 * anything else would store a widget that can only fail at render time.
 * Storing the parsed output (defaults filled, unknown keys dropped) means what
 * is stored is exactly what renders. Shared by the create and the update so a
 * spec the create would refuse cannot arrive through an edit either: the
 * update checks the spec against the widget's stored type, and a spec in the
 * other dialect is refused with a message naming the expected one.
 */
function parseWidgetSpec(
  type: WidgetType,
  spec: Record<string, unknown>,
): { ok: true; spec: Record<string, unknown> } | { ok: false; error: string } {
  if (type === "query") {
    const specParsed = WidgetSpecSchema.safeParse(spec);
    if (!specParsed.success) {
      const issue = specParsed.error.issues[0];
      const path = issue.path.join(".");
      return {
        ok: false,
        error: `spec is not a valid widget spec: ${path ? `${path}: ` : ""}${issue.message}`,
      };
    }
    // Shape-valid is not enough: the fields the spec names must exist in the
    // registry vocabulary, or the widget stores fine and 4xxs forever at
    // query time.
    const vocabulary = validateWidgetSpecVocabulary(specParsed.data);
    if (!vocabulary.ok) return { ok: false, error: vocabulary.error };
    return { ok: true, spec: specParsed.data };
  }
  const feedParsed = parseTraceFeedSpec(spec);
  if (!feedParsed.ok) {
    return { ok: false, error: `spec is not a valid trace_feed spec: ${feedParsed.error}` };
  }
  return { ok: true, spec: feedParsed.data as unknown as Record<string, unknown> };
}

/** What a create transaction returns: the caller's result plus the audit entry
 *  to record once the transaction has committed. Writing the audit row inside
 *  the transaction would let a failed INSERT abort it and discard the resource. */
type TxOutcome<T> = Promise<{ result: ServiceResult<T>; audit?: AuditEntry }>;

/**
 * Room reserved for the collision suffix when a requested name sits at the
 * cap: " (2)" through " (999)" all fit. A project would need close to a
 * thousand same-named dashboards before the search prefix below stopped
 * covering every candidate.
 */
const SUFFIX_ROOM = " (999)".length;

/**
 * How many same-prefix names the collision lookup reads. A project needs this
 * many dashboards sharing one name before the pick is refused — a bound on
 * the scan, not a quota anyone reaches by accident.
 */
export const DASHBOARD_NAME_COLLISION_LOOKUP_LIMIT = 100;

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
  // A same-name dashboard in this project means different things per
  // transport. Over the public API (and the CLI on top of it) the create is
  // idempotent: the existing row comes back as-is, so a retried request
  // can't fan out duplicates. The agent never reuses: a human just
  // confirmed "Create dashboard X" on the chat card, so something must
  // actually be created — it lands under the first free suffixed name
  // ("X (2)", "X (3)", …) and the result says what it was renamed from.
  // uq_dashboard_project_name is the backstop for both under concurrency,
  // and a P2002 is answered per transport too: reuse for the public API,
  // one fresh pick of the suffix for the agent.
  const agentTransport = input.provenance.transport === "agent";
  for (let attempt = 0; ; attempt++) {
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

        let finalName = name;
        let renamedFrom: string | undefined;
        if (agentTransport) {
          const taken = await tx.dashboard.findMany({
            where: { projectId: input.projectId, name: { startsWith: suffixSearchPrefix(name) } },
            select: { name: true },
            orderBy: { name: "asc" },
            take: DASHBOARD_NAME_COLLISION_LOOKUP_LIMIT,
          });
          if (taken.length >= DASHBOARD_NAME_COLLISION_LOOKUP_LIMIT) {
            // A full page means a suffix picked here might still collide
            // past it; refuse rather than scan further or retry blind.
            return {
              result: {
                ok: false,
                status: 409,
                error: `Too many dashboards share the name "${name}"; choose a different name`,
              },
            };
          }
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
    } catch (e) {
      if (!isPrismaKnownError(e, "P2002")) throw e;
      if (agentTransport) {
        // The suffix was chosen from a lookup and taken before the insert
        // landed; one more pick from a fresh lookup settles it. A second
        // collision is not a race worth chasing.
        if (attempt === 0) continue;
        throw e;
      }
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
    const specParsed = parseWidgetSpec(type, parsed.data.spec as Record<string, unknown>);
    if (!specParsed.ok) {
      return { result: { ok: false, status: 400, error: specParsed.error } };
    }
    const spec = specParsed.spec;
    const displayConfig = (parsed.data.displayConfig as Record<string, unknown> | undefined) ?? {};

    // Widgets have no natural key (duplicate titles are legitimate), so this
    // is a strict create — every call adds a widget. Callers pass no layout:
    // a widget with no placement renders through the grid's unpersisted
    // fallback, as a narrow stack down the left edge, so placement is ours.
    const widget = await createWidgetWithPlacement(
      tx,
      { dashboardId: input.dashboardId, projectId: input.projectId, type },
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

/** The placement keys a layout entry stores; the grid honors nothing else. */
const gridUnit = z.number().nonnegative().finite();
const placementSchema = z.object({
  i: z.string().max(128),
  x: gridUnit,
  y: gridUnit,
  w: gridUnit,
  h: gridUnit,
});
const layoutEntrySchema = z.unknown().transform((value, ctx) => {
  const placement = placementSchema.safeParse(value);
  if (placement.success) return placement.data;
  ctx.addIssue({ code: "custom", message: "layout entries must be {i, x, y, w, h} objects" });
  return z.NEVER;
});

// Every field optional and the same messages as the create; `layout` is the
// web app's drag interaction and is not exposed on the public surface, but the
// cookie route delegates here, so the validator lives beside the others. Only
// the placement keys are kept: extra keys smuggled through (static,
// isDraggable, maxW) would be persisted and honored for every member.
const dashboardPatchSchema = z.object({
  name: dashboardSchema.shape.name.optional(),
  description: dashboardSchema.shape.description,
  layout: z.array(layoutEntrySchema, "layout must be an array").optional(),
});

const widgetPatchSchema = z.object({
  title: widgetSchema.shape.title.optional(),
  spec: jsonObject("spec must be a JSON object", false),
  // Nullable: null resets the display config to the column default.
  displayConfig: z.unknown().superRefine((value, ctx) => {
    if (value === undefined || value === null) return;
    if (!isPlainObject(value)) {
      ctx.addIssue({ code: "custom", message: "displayConfig must be a JSON object" });
    }
  }),
});

const DASHBOARD_NOT_FOUND = { ok: false, status: 404, error: "Dashboard not found" } as const;
const WIDGET_NOT_FOUND = { ok: false, status: 404, error: "Widget not found" } as const;
const DASHBOARD_NAME_TAKEN = {
  ok: false,
  status: 409,
  error: "A dashboard with this name already exists",
} as const;

/**
 * Partially update a dashboard's name, description or layout for a MEMBER of
 * its project. A name collision, including one that appears between the read
 * and the write, is a 409; a concurrent delete is a 404.
 */
export async function updateDashboard(input: {
  actorUserId: string;
  projectId: string;
  dashboardId: string;
  patch: { name?: string; description?: string | null; layout?: unknown };
  provenance: Provenance;
}): Promise<UpdateResult<Dashboard>> {
  let outcome: Awaited<EditOutcome<UpdateResult<Dashboard>>>;
  try {
    outcome = await prisma.$transaction(async (tx): EditOutcome<UpdateResult<Dashboard>> => {
      const access = await requireProjectMember(tx, input.projectId, input.actorUserId);
      if (!access.ok) return { result: access };

      const parsed = dashboardPatchSchema.safeParse(input.patch);
      if (!parsed.success) {
        return { result: { ok: false, status: 400, error: parsed.error.issues[0].message } };
      }
      const patch = {
        name: parsed.data.name?.trim(),
        description: parsed.data.description,
        layout: parsed.data.layout,
      };
      if (definedKeys(patch).length === 0) {
        return { result: { ok: false, status: 400, error: NO_FIELDS_MESSAGE } };
      }

      // A layout rewrite is the same read-modify-write the widget create and
      // delete serialize under the dashboard row lock. Without it, a drag
      // committed against a stale read would put a deleted widget's placement
      // back, or drop a created one's. Taken before the read below so the
      // diff is against the row the last rewrite left.
      if (patch.layout !== undefined) {
        await lockDashboardLayout(tx, input.dashboardId, input.projectId);
      }

      const existing = await tx.dashboard.findFirst({
        where: { id: input.dashboardId, projectId: input.projectId },
      });
      if (!existing) return { result: DASHBOARD_NOT_FOUND };

      const { changed, data } = diffPatch(patch, existing);
      if (changed.length === 0) return { result: { ok: true, data: existing, changed } };

      const dashboard = await tx.dashboard.update({ where: { id: existing.id }, data });
      return {
        result: { ok: true, data: dashboard, changed },
        audit: {
          actorUserId: input.actorUserId,
          operation: "update_dashboard",
          resourceType: "dashboard",
          resourceId: dashboard.id,
          workspaceId: access.workspaceId,
          projectId: input.projectId,
          summary: { changed },
          transport: input.provenance.transport,
          agentSessionId: input.provenance.agentSessionId ?? null,
        },
      };
    });
  } catch (e) {
    // Deleted concurrently between the scoped read and the write.
    if (isPrismaKnownError(e, "P2025")) return DASHBOARD_NOT_FOUND;
    // Rename collided with another dashboard's name (uq_dashboard_project_name).
    if (isPrismaKnownError(e, "P2002")) return DASHBOARD_NAME_TAKEN;
    throw e;
  }
  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}

/**
 * Hard-delete a dashboard with its widgets for a MEMBER of its project. The
 * project's last dashboard is refused: the list endpoint reseeds a default
 * whenever a project has none, so deleting it would only resurrect a copy.
 */
export async function deleteDashboard(input: {
  actorUserId: string;
  projectId: string;
  dashboardId: string;
  reason: string;
  provenance: Provenance;
}): Promise<DeleteResult> {
  const reason = validateDeleteReason(input.reason);
  if (!reason.ok) return reason;

  let outcome: Awaited<EditOutcome<DeleteResult>>;
  try {
    outcome = await prisma.$transaction(async (tx): EditOutcome<DeleteResult> => {
      const access = await requireProjectMember(tx, input.projectId, input.actorUserId);
      if (!access.ok) return { result: access };

      // The count below is only a guard if nothing else deletes meanwhile:
      // two concurrent deletes of a project's last two dashboards would each
      // count two and both pass. Locking the project row serializes them, so
      // the second counts what the first left. The row is read under the
      // same lock, so a second delete of this same dashboard sees it gone and
      // 404s rather than tripping the guard. Raw because Prisma has no
      // row-lock API; the table name is the mapped one from the schema.
      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${input.projectId} FOR UPDATE`;
      const existing = await tx.dashboard.findFirst({
        where: { id: input.dashboardId, projectId: input.projectId },
      });
      if (!existing) return { result: DASHBOARD_NOT_FOUND };

      const remaining = await tx.dashboard.count({ where: { projectId: input.projectId } });
      if (remaining <= 1) {
        return {
          result: { ok: false, status: 409, error: "Cannot delete a project's last dashboard" },
        };
      }
      const cascaded = { widgets: await tx.widget.count({ where: { dashboardId: existing.id } }) };
      await tx.dashboard.delete({ where: { id: existing.id } });
      return {
        result: {
          ok: true,
          data: { id: existing.id, name: existing.name },
          reason: reason.reason,
          cascaded,
        },
        audit: {
          actorUserId: input.actorUserId,
          operation: "delete_dashboard",
          resourceType: "dashboard",
          resourceId: existing.id,
          workspaceId: access.workspaceId,
          projectId: input.projectId,
          summary: { name: existing.name, reason: reason.reason, cascaded },
          transport: input.provenance.transport,
          agentSessionId: input.provenance.agentSessionId ?? null,
        },
      };
    });
  } catch (e) {
    if (isPrismaKnownError(e, "P2025")) return DASHBOARD_NOT_FOUND;
    throw e;
  }
  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}

/**
 * Partially update a widget's title, spec or display config for a MEMBER of
 * its project. The widget is resolved through its dashboard's project, so a
 * widget id from another project is a 404; `dashboardId`, when given, must
 * also match (the cookie route's nested path). `type` is immutable: the spec
 * is validated against the stored type with the create's parser.
 */
export async function updateWidget(input: {
  actorUserId: string;
  projectId: string;
  widgetId: string;
  dashboardId?: string;
  patch: {
    title?: string;
    spec?: Record<string, unknown>;
    displayConfig?: Record<string, unknown> | null;
  };
  provenance: Provenance;
}): Promise<UpdateResult<Widget>> {
  let outcome: Awaited<EditOutcome<UpdateResult<Widget>>>;
  try {
    outcome = await prisma.$transaction(async (tx): EditOutcome<UpdateResult<Widget>> => {
      const access = await requireProjectMember(tx, input.projectId, input.actorUserId);
      if (!access.ok) return { result: access };

      const parsed = widgetPatchSchema.safeParse(input.patch);
      if (!parsed.success) {
        return { result: { ok: false, status: 400, error: parsed.error.issues[0].message } };
      }
      const rawSpec = parsed.data.spec as Record<string, unknown> | undefined;
      const patch: {
        title?: string;
        spec?: Record<string, unknown>;
        displayConfig?: Record<string, unknown>;
      } = {
        title: parsed.data.title?.trim(),
        spec: rawSpec,
        displayConfig:
          parsed.data.displayConfig === null
            ? {}
            : (parsed.data.displayConfig as Record<string, unknown> | undefined),
      };
      if (definedKeys(patch).length === 0) {
        return { result: { ok: false, status: 400, error: NO_FIELDS_MESSAGE } };
      }

      const existing = await tx.widget.findFirst({
        where: {
          id: input.widgetId,
          ...(input.dashboardId === undefined ? {} : { dashboardId: input.dashboardId }),
          dashboard: { projectId: input.projectId },
        },
      });
      if (!existing) return { result: WIDGET_NOT_FOUND };

      if (rawSpec !== undefined) {
        const specParsed = parseWidgetSpec(existing.type as WidgetType, rawSpec);
        if (!specParsed.ok) return { result: { ok: false, status: 400, error: specParsed.error } };
        patch.spec = specParsed.spec;
      }

      const { changed, data } = diffPatch(patch, existing);
      if (changed.length === 0) return { result: { ok: true, data: existing, changed } };

      const widget = await tx.widget.update({
        where: { id: existing.id },
        data: data as { title?: string; spec?: object; displayConfig?: object },
      });
      return {
        result: { ok: true, data: widget, changed },
        audit: {
          actorUserId: input.actorUserId,
          operation: "update_widget",
          resourceType: "widget",
          resourceId: widget.id,
          workspaceId: access.workspaceId,
          projectId: input.projectId,
          summary: { changed },
          transport: input.provenance.transport,
          agentSessionId: input.provenance.agentSessionId ?? null,
        },
      };
    });
  } catch (e) {
    // Deleted concurrently between the scoped read and the write.
    if (isPrismaKnownError(e, "P2025")) return WIDGET_NOT_FOUND;
    throw e;
  }
  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}

/**
 * Hard-delete a widget for a MEMBER of its project and drop its entry from
 * the dashboard's stored layout in the same transaction, so the grid never
 * carries a placement for a tile that no longer exists.
 */
export async function deleteWidget(input: {
  actorUserId: string;
  projectId: string;
  widgetId: string;
  dashboardId?: string;
  reason: string;
  provenance: Provenance;
}): Promise<DeleteResult> {
  const reason = validateDeleteReason(input.reason);
  if (!reason.ok) return reason;

  let outcome: Awaited<EditOutcome<DeleteResult>>;
  try {
    outcome = await prisma.$transaction(async (tx): EditOutcome<DeleteResult> => {
      const access = await requireProjectMember(tx, input.projectId, input.actorUserId);
      if (!access.ok) return { result: access };

      const existing = await tx.widget.findFirst({
        where: {
          id: input.widgetId,
          ...(input.dashboardId === undefined ? {} : { dashboardId: input.dashboardId }),
          dashboard: { projectId: input.projectId },
        },
      });
      if (!existing) return { result: WIDGET_NOT_FOUND };

      await deleteWidgetWithPlacement(
        tx,
        { id: existing.id, dashboardId: existing.dashboardId, projectId: input.projectId },
        () => tx.widget.delete({ where: { id: existing.id } }),
      );
      return {
        result: {
          ok: true,
          data: { id: existing.id, name: existing.title },
          reason: reason.reason,
        },
        audit: {
          actorUserId: input.actorUserId,
          operation: "delete_widget",
          resourceType: "widget",
          resourceId: existing.id,
          workspaceId: access.workspaceId,
          projectId: input.projectId,
          summary: { name: existing.title, reason: reason.reason },
          transport: input.provenance.transport,
          agentSessionId: input.provenance.agentSessionId ?? null,
        },
      };
    });
  } catch (e) {
    if (isPrismaKnownError(e, "P2025")) return WIDGET_NOT_FOUND;
    throw e;
  }
  if (outcome.audit) await writeAudit(prisma, outcome.audit);
  return outcome.result;
}
