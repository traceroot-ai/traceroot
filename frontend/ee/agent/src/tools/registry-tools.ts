import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  ApiClient,
  INTERNAL_BINDINGS,
  REGISTRY,
  internalAuth,
  toPiAgentTool,
} from "@traceroot-ai/tools";
import { alertDetailCardDetails, alertListCardDetails } from "./alert-card-details.js";
import {
  formatDashboardData,
  formatAlertDetail,
  formatAlertList,
  formatDashboardDetail,
  formatDashboardList,
  formatDetectorDetail,
  DATASET_CASE_ROW_CAP,
  DATASET_LIST_PAGE_SIZE,
  formatDatasetDetail,
  formatDatasetList,
  formatDatasetVersionDetail,
  formatDatasetVersionList,
  formatDetectorList,
  formatEvaluationRun,
  formatFindingDetail,
  formatFindingList,
  formatSessionDetail,
  formatSessionList,
  formatTraceList,
  formatWidgetData,
  formatWidgetDetail,
  formatWidgetQueryResult,
} from "./formatters.js";
import { publicUiUrl } from "./origins.js";
import { type QueryWindow, windowDefaults } from "./query-window.js";
import { agentInternalSecret } from "../internal-secret.js";

function requireEntry(name: string) {
  const entry = REGISTRY.find((e) => e.name === name);
  if (entry === undefined) {
    throw new Error(`registry entry missing: ${name}`);
  }
  return entry;
}

/** A read's first page: no cursor is ever sent, and the model is never offered one. */
const FIRST_PAGE = { cursor: undefined };

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
    headers: internalAuth(agentInternalSecret(), userId),
  });
  const bind = (
    name: string,
    formatResult: (data: unknown) => string,
    options: {
      /** Values for params the model omits — the page window for the data reads. */
      defaults?: ReturnType<typeof windowDefaults>;
      /** Structured details the chat panel cards, beside the text the model reads. */
      details?: (data: unknown) => unknown;
      /** Params set on every call and hidden from the model, beside the project id. */
      pinned?: Record<string, unknown>;
      /** Rewrites the registry's description where this surface pins a param it names. */
      describe?: (registryText: string) => string;
    } = {},
  ) => {
    const { defaults, details, pinned = {}, describe } = options;
    const entry = requireEntry(name);
    // A pin for a param the registry no longer has would silently hand the renamed param
    // back to the model, so a stale pin fails loudly; every tool is built in the tests.
    for (const key of Object.keys(pinned)) {
      if (!(key in entry.inputSchema.properties)) {
        throw new Error(`${name}: pinned param "${key}" is not in the registry entry`);
      }
    }
    const described = describe?.(entry.description) ?? entry.description;
    // The registry text says an omitted window means the site's default; in
    // the chat it means the window the user is looking at. Said on the tool
    // and on the range parameter itself, so the schema cannot contradict it.
    // The page's own range is named when there is one, so the description
    // points at a concrete window instead of an invisible default.
    const onThePage = `the window the user is looking at on the page${
      window?.range !== undefined
        ? ` (${window.range})`
        : window?.start_time !== undefined && window.end_time !== undefined
          ? ` (${window.start_time} → ${window.end_time})`
          : ""
    }`;
    const tool = toPiAgentTool(entry, {
      client,
      pathOverride: INTERNAL_BINDINGS[name],
      fixedArgs: { ...pinned, project_id: projectId },
      formatResult,
      details,
      ...(describe !== undefined && { description: described }),
      ...(defaults !== undefined && {
        defaults,
        description: described.replace(
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
  // The data reads default to the window the page is showing, so the agent's
  // numbers match the dashboard beside it unless the user named a window of
  // their own.
  const pageWindow = windowDefaults(window);
  // A link a person will click: the browser-reachable origin, never the
  // service-to-service one.
  const dashboardUrl = (id: string) => `${publicUiUrl()}/projects/${projectId}/dashboard/${id}`;
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
    bind("run_widget_query", formatWidgetQueryResult, { defaults: pageWindow }),
    bind("get_dashboard_data", (data) => formatDashboardData(data, { dashboardUrl }), {
      defaults: pageWindow,
    }),
    bind("get_widget", formatWidgetDetail),
    bind("get_widget_data", (data) => formatWidgetData(data, { dashboardUrl }), {
      defaults: pageWindow,
    }),
    // The two alert reads are carded in the chat: a compact projection of
    // the payload rides beside the text so the panel can draw rows and a
    // badge without re-reading the model's prose.
    bind("list_alerts", formatAlertList, { details: alertListCardDetails }),
    bind("get_alert", formatAlertDetail, { details: alertDetailCardDetails }),
    bind("get_evaluation_run", formatEvaluationRun),
    // These reads return the first page of a list and no further, as the CLI does. The
    // cursor is pinned off and hidden, so the model cannot page, nor guess a cursor that
    // matches no row and reads back as an empty last page. The list size is pinned to the
    // most the API serves, so "more exist" is true of everything the page leaves out.
    bind("list_datasets", formatDatasetList, {
      pinned: { ...FIRST_PAGE, limit: DATASET_LIST_PAGE_SIZE },
    }),
    bind("get_dataset", formatDatasetDetail),
    bind("list_dataset_versions", formatDatasetVersionList, {
      pinned: { ...FIRST_PAGE, limit: DATASET_LIST_PAGE_SIZE },
    }),
    // A version read is pinned to the cases the formatter shows, so the one page it reads is
    // exactly the page the model sees. The pin matters: without a limit the API returns the
    // whole version in one response, each field up to 1 MB. The registry text tells a caller
    // to pass a limit and follow next_cursor; here both are pinned, so that sentence is
    // replaced with what the tool actually does.
    bind("get_dataset_version", formatDatasetVersionDetail, {
      pinned: { ...FIRST_PAGE, limit: DATASET_CASE_ROW_CAP },
      describe: (text) =>
        text.replace(
          / Always pass limit[^.]*\./,
          ` Returns the version's first ${DATASET_CASE_ROW_CAP} cases, and says when it has more.`,
        ),
    }),
  ];
}
