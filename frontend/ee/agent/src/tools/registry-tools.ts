import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  ApiClient,
  INTERNAL_BINDINGS,
  REGISTRY,
  internalAuth,
  toPiAgentTool,
} from "@traceroot-ai/tools";
import {
  formatDashboardData,
  formatDashboardDetail,
  formatDashboardList,
  formatDetectorDetail,
  formatDetectorList,
  formatFindingDetail,
  formatFindingList,
  formatSessionDetail,
  formatSessionList,
  formatTraceList,
  formatWidgetQueryResult,
} from "./formatters.js";
import { type QueryWindow, windowDefaults } from "./query-window.js";

function requireEntry(name: string) {
  const entry = REGISTRY.find((e) => e.name === name);
  if (entry === undefined) {
    throw new Error(`registry entry missing: ${name}`);
  }
  return entry;
}

/**
 * The agent's read tools, generated from the shared registry and bound to the
 * internal project-scoped routes with service auth. Presentation (the text the
 * model sees) stays here — it's surface-local by design.
 */
export function createRegistryReadTools(
  projectId: string,
  userId: string,
  window?: QueryWindow,
): AgentTool<any>[] {
  const client = new ApiClient({
    baseUrl: process.env.BACKEND_INTERNAL_URL || "http://localhost:8000",
    headers: internalAuth(process.env.INTERNAL_API_SECRET || "", userId),
  });
  const bind = (
    name: string,
    formatResult: (data: unknown) => string,
    defaults?: ReturnType<typeof windowDefaults>,
  ) => {
    const entry = requireEntry(name);
    // The registry text says an omitted window means the site's default; in
    // the chat it means the window the user is looking at. Said on the tool
    // and on the range parameter itself, so the schema cannot contradict it.
    const onThePage = "the window the user is looking at on the page";
    const tool = toPiAgentTool(entry, {
      client,
      pathOverride: INTERNAL_BINDINGS[name],
      fixedArgs: { project_id: projectId },
      formatResult,
      ...(defaults !== undefined && {
        defaults,
        description: entry.description.replace(
          /neither means the site's default[^.)]*/,
          `leave it out to answer for ${onThePage}`,
        ),
      }),
    }) as AgentTool<any>;
    const range = tool.parameters.properties.range as { description?: string } | undefined;
    if (defaults !== undefined && range?.description !== undefined) {
      // A defensive copy: don't depend on toPiAgentTool having cloned the schema.
      tool.parameters.properties.range = {
        ...range,
        description: range.description.replace(
          /neither means the site's[^.]*/,
          `leave both out to answer for ${onThePage}`,
        ),
      };
    }
    return tool;
  };
  // The two data reads default to the window the page is showing, so the
  // agent's numbers match the dashboard beside it unless the user named a
  // window of their own.
  const pageWindow = windowDefaults(window);
  return [
    bind("list_traces", formatTraceList),
    bind("list_sessions", formatSessionList),
    bind("get_session", formatSessionDetail),
    bind("list_detectors", formatDetectorList),
    bind("get_detector", formatDetectorDetail),
    bind("list_findings", formatFindingList),
    bind("get_finding", formatFindingDetail),
    bind("get_finding_by_trace", formatFindingDetail),
    bind("list_dashboards", formatDashboardList),
    bind("get_dashboard", formatDashboardDetail),
    bind("run_widget_query", formatWidgetQueryResult, pageWindow),
    bind("get_dashboard_data", formatDashboardData, pageWindow),
  ];
}
