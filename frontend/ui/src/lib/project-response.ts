import { DEFAULT_ALERT_WINDOW, hasMinRole, Role, type Prisma } from "@traceroot/core";

type ProjectDetails = Prisma.ProjectGetPayload<{ include: { alertConfig: true } }>;

export function projectDetailsResponse(project: ProjectDetails, role: Role) {
  return {
    id: project.id,
    name: project.name,
    trace_ttl_days: project.traceTtlDays,
    rca_model: project.rcaModel,
    rca_provider: project.rcaProvider,
    rca_source: project.rcaSource,
    ...(hasMinRole(role, Role.ADMIN)
      ? { alert_emails: project.alertConfig?.emailAddresses ?? [] }
      : {}),
    alert_window: project.alertConfig?.alertWindow ?? DEFAULT_ALERT_WINDOW,
    create_time: project.createTime,
    update_time: project.updateTime,
  };
}
