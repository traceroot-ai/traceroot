import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  ApiClient,
  ApiError,
  INTERNAL_WRITE_BINDINGS,
  REGISTRY,
  type ParamSchema,
  type RegistryEntry,
} from "@traceroot-ai/tools";

/**
 * Per-tool execution shape the registry cannot express: how each public
 * snake_case field maps onto the internal write route's camelCase body, and
 * how the route's `{ created, <resource>: {...} }` response reads back.
 * The model-visible schema and policy still come from the registry entry.
 */
interface WriteToolSpec {
  /**
   * Agent-facing wording that replaces the registry description when the
   * chat agent's execution differs from the public API's (the registry
   * text documents the API/CLI contract).
   */
  description?: string;
  /** Public snake_case field → internal camelCase body key (tenancy fields excluded). */
  fieldMap: Record<string, string>;
  /** Key holding the resource in the route's success payload. */
  resourceKey: "detector" | "dashboard" | "widget";
  /** Field naming the resource in the success text. */
  displayNameKey: "name" | "title";
}

/**
 * Structured success payload surfaced to the UI through the tool result's
 * `details` (forwarded verbatim over the agent service's SSE stream), so the
 * panel can link to — or navigate to — the resource a write tool touched.
 */
export interface ResourceCreatedDetails {
  kind: "resource_created";
  /**
   * Wider than WriteToolSpec["resourceKey"]: the chat agent no longer binds
   * create_workspace / create_project, but older persisted tool_step rows
   * from when it did still carry "workspace" and "project", and the UI's
   * receipt cards keep rendering them.
   */
  resourceType: "workspace" | "project" | "detector" | "dashboard" | "widget";
  resourceId: string;
  /** The name (or title) the resource actually carries — for a dashboard,
   *  possibly not the one the model asked for (see renamedFrom). */
  name?: string;
  /** The name the model asked for, when the service created the dashboard
   *  under a suffixed one because that name was already taken. */
  renamedFrom?: string;
  /** false when the write was idempotent and an existing resource was reused. */
  created: boolean;
  projectId?: string;
  /** Only on older persisted rows from the retired create_project tool; the UI still reads it. */
  workspaceId?: string;
  dashboardId?: string;
}

// No create_workspace / create_project here: the agent's tenancy is force-
// injected from its session, so a workspace or project it created could never
// be targeted by any later call — structural creates are CLI/API surface.
const WRITE_TOOL_SPECS: Readonly<Record<string, WriteToolSpec>> = {
  create_detector: {
    fieldMap: {
      name: "name",
      template: "template",
      prompt: "prompt",
      sample_rate: "sampleRate",
      output_schema: "outputSchema",
      trigger_conditions: "triggerConditions",
      detection_source: "detectionSource",
      detection_model: "detectionModel",
      detection_provider: "detectionProvider",
      enable_rca: "enableRca",
      enabled: "enabled",
    },
    resourceKey: "detector",
    displayNameKey: "name",
  },
  create_dashboard: {
    // The API/CLI create is idempotent on the name; the agent's is not — a
    // human just confirmed the create on the chat card, so a same-name
    // dashboard is created under a suffixed name rather than reused.
    description:
      "Create a dashboard in a project; add charts to it with create_widget. If a dashboard " +
      "with the requested name already exists, the new one is created under the requested " +
      'name with " (2)" appended (then " (3)", …), trimmed to fit the name limit if the ' +
      "requested name is long. The result reports the name it was given, so use that name " +
      "afterwards rather than the one you asked for.",
    fieldMap: { name: "name", description: "description" },
    resourceKey: "dashboard",
    displayNameKey: "name",
  },
  create_widget: {
    fieldMap: {
      dashboard_id: "dashboardId",
      title: "title",
      type: "type",
      spec: "spec",
      display_config: "displayConfig",
    },
    resourceKey: "widget",
    displayNameKey: "title",
  },
};

export interface CreateRegistryWriteToolsOptions {
  /** Carries the UI-app base URL and internal auth headers (wired by the caller). */
  client: ApiClient;
  /** The authenticated user the write is performed on behalf of. */
  actorUserId: string;
  /** The agent session recorded as write provenance. */
  agentSessionId: string;
  /** The session's project, injected as the ambient tenancy of every write. */
  projectId: string;
}

function requireWriteEntry(name: string): RegistryEntry & {
  policy: NonNullable<RegistryEntry["policy"]>;
} {
  const entry = REGISTRY.find((e) => e.name === name);
  if (entry === undefined) {
    throw new Error(`registry entry missing: ${name}`);
  }
  const { policy } = entry;
  if (policy === undefined) {
    throw new Error(`registry entry missing policy: ${name}`);
  }
  return { ...entry, policy };
}

/** "create_widget" -> "Create widget" for the tool's human-readable label. */
function humanizeName(name: string): string {
  const words = name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * "Created detector "latency" (id d1)" / already-exists variant, plus the
 * structured details the UI consumes. `tenancyIds` is the ambient projectId
 * the tool injected into the write.
 */
function buildWriteSuccess(
  spec: WriteToolSpec,
  tenancyIds: { projectId: string },
  result: unknown,
): { text: string; details: ResourceCreatedDetails | undefined } {
  const payload = result as Record<string, unknown>;
  const resource = payload[spec.resourceKey] as Record<string, unknown> | undefined;
  const id = resource?.id;
  const displayName = resource?.[spec.displayNameKey];
  if (typeof id !== "string" || typeof displayName !== "string") {
    // Unexpected payload shape: show it verbatim rather than guessing.
    return { text: JSON.stringify(result, null, 2), details: undefined };
  }
  const created = payload.created !== false;
  const details: ResourceCreatedDetails = {
    kind: "resource_created",
    resourceType: spec.resourceKey,
    resourceId: id,
    name: displayName,
    created,
    ...tenancyIds,
  };
  // Widgets live under a dashboard; the route echoes which one.
  if (typeof resource?.dashboardId === "string") {
    details.dashboardId = resource.dashboardId;
  }
  // The dashboard route reports, beside the row, the name it had to rename
  // away from; the model must learn the real name before it refers to it.
  if (typeof payload.renamedFrom === "string") {
    details.renamedFrom = payload.renamedFrom;
    return {
      text:
        `Created ${spec.resourceKey} "${displayName}" — a ${spec.resourceKey} named ` +
        `"${payload.renamedFrom}" already existed, so this one got a new name (id ${id})`,
      details,
    };
  }
  if (created) {
    return { text: `Created ${spec.resourceKey} "${displayName}" (id ${id})`, details };
  }
  const capitalized = spec.resourceKey.charAt(0).toUpperCase() + spec.resourceKey.slice(1);
  return {
    text: `${capitalized} "${displayName}" already exists (id ${id}) — reusing it`,
    details,
  };
}

/**
 * Extract the internal write routes' `{error}` message from a non-2xx
 * response. ApiClient surfaces unknown error bodies as their raw text; the
 * write routes always answer failures with JSON `{"error": "..."}`.
 */
function apiErrorMessage(error: ApiError): string {
  try {
    const parsed = JSON.parse(error.detail) as { error?: unknown };
    if (typeof parsed.error === "string") {
      return `API error ${error.status}: ${parsed.error}`;
    }
  } catch {
    // non-JSON detail: keep ApiError's own message
  }
  return error.message;
}

/**
 * The agent's write tools: model-visible schema and policy come from the
 * shared registry (minus the ambient tenancy field the factory injects), but
 * execution binds directly to the internal Next-app write routes — the same
 * snake→camel edge translation the public API route performs, plus the
 * trusted actor/provenance fields. Deliberately not routed through
 * dispatch(): its path/query/body partitioning is public-API-specific.
 */
export function createRegistryWriteTools(opts: CreateRegistryWriteToolsOptions): AgentTool<any>[] {
  const { client, actorUserId, agentSessionId, projectId } = opts;

  const bind = (name: string): AgentTool<any> => {
    const entry = requireWriteEntry(name);
    const spec = WRITE_TOOL_SPECS[name];
    const path = INTERNAL_WRITE_BINDINGS[name];

    // The ambient project is injected, never model-supplied. Only project-
    // tenancy writes are bound here (see WRITE_TOOL_SPECS): fail loud at
    // wiring time if the registry ever moves one of them to another scope.
    if (entry.policy.tenancy !== "project") {
      throw new Error(`${name}: unsupported tenancy for the chat agent: ${entry.policy.tenancy}`);
    }
    const hiddenField = "project_id";
    const tenancyBody = { projectId };

    // Registry-curated fields the agent must neither show to the model nor
    // accept from it (the API/CLI keep them; the fieldMap may still know the
    // translation so un-hiding a field is a curation-only change).
    const agentHidden = new Set(entry.agentHiddenParams ?? []);
    const modelVisible = (field: string): boolean =>
      field !== hiddenField && !agentHidden.has(field);

    // Fail loud at wiring time if the generated registry gains a field the
    // explicit body map doesn't know how to translate.
    for (const field of Object.keys(entry.inputSchema.properties)) {
      if (modelVisible(field) && !(field in spec.fieldMap)) {
        throw new Error(`${name}: unmapped registry field: ${field}`);
      }
    }

    const properties: Record<string, ParamSchema> = {
      label: {
        type: "string",
        description: "Brief description of what this call is doing (shown to the user)",
      },
    };
    for (const [field, schema] of Object.entries(entry.inputSchema.properties)) {
      if (modelVisible(field)) {
        properties[field] = schema;
      }
    }
    const required = ["label", ...entry.inputSchema.required.filter(modelVisible)];

    return {
      name: entry.name,
      label: humanizeName(entry.name),
      description: spec.description ?? entry.description,
      parameters: { type: "object", properties, required, additionalProperties: false },
      execute: async (
        _toolCallId,
        rawParams,
        signal,
      ): Promise<AgentToolResult<ResourceCreatedDetails | undefined>> => {
        const { label: _label, ...params } = (rawParams ?? {}) as Record<string, unknown>;
        const body: Record<string, unknown> = {
          actorUserId,
          transport: "agent",
          agentSessionId,
          ...tenancyBody,
        };
        for (const [field, bodyKey] of Object.entries(spec.fieldMap)) {
          // A hidden field the model passes anyway must never reach the body.
          if (agentHidden.has(field)) {
            continue;
          }
          const value = params[field];
          // Unset optionals stay out of the body entirely — the internal zod
          // distinguishes absent from null in places, and absent is always safe.
          if (value !== undefined && value !== null) {
            body[bodyKey] = value;
          }
        }
        try {
          const result = await client.request("post", path, { body, signal });
          const { text, details } = buildWriteSuccess(spec, tenancyBody, result);
          return { content: [{ type: "text", text }], details };
        } catch (error) {
          // Deliberate divergence from the runtime's throw-on-failure contract:
          // errors are returned as tool-result text so the model can read the
          // failure (status, detail) and adapt — matching the read tools.
          const message =
            error instanceof ApiError
              ? apiErrorMessage(error)
              : error instanceof Error
                ? error.message
                : String(error);
          return {
            content: [{ type: "text", text: `Error calling ${entry.name}: ${message}` }],
            details: undefined,
          };
        }
      },
    } as AgentTool<any>;
  };

  return [bind("create_detector"), bind("create_dashboard"), bind("create_widget")];
}
