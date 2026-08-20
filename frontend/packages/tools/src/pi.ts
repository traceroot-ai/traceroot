import type { ApiClient } from "./client.js";
import { dispatch } from "./dispatch.js";
import { sanitizeSchemaForModel } from "./schema.js";
import type { ParamSchema, RegistryEntry } from "./types.js";

/** One text block of a pi tool result. */
export interface PiToolResultContent {
  type: "text";
  text: string;
}

export interface PiToolResult {
  content: PiToolResultContent[];
  details: undefined;
}

/**
 * The agent runtime's tool shape, matched structurally so this package needs
 * no dependency on it.
 */
export interface PiAgentTool {
  name: string;
  label: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ParamSchema>;
    required: string[];
    additionalProperties: false;
  };
  execute: (toolCallId: string, rawParams: unknown, signal?: AbortSignal) => Promise<PiToolResult>;
}

export interface ToPiAgentToolOptions {
  client: ApiClient;
  /** Alternative path template (e.g. an internal project-scoped route). */
  pathOverride?: string;
  /**
   * Args injected on every call and hidden from the model's schema
   * (e.g. the project id an internal route template needs).
   */
  fixedArgs?: Record<string, unknown>;
  /** Renders the API result for the model; defaults to pretty-printed JSON. */
  formatResult?: (result: unknown) => string;
}

/** "list_traces" -> "List traces" for the tool's human-readable label. */
function humanizeName(name: string): string {
  const words = name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Adapt a registry entry to the pi agent tool shape: inject the required
 * model-supplied `label` param, hide fixedArgs from the model, and render
 * results and errors as text content.
 */
export function toPiAgentTool(entry: RegistryEntry, options: ToPiAgentToolOptions): PiAgentTool {
  const { client, pathOverride, fixedArgs = {}, formatResult } = options;

  const properties: Record<string, ParamSchema> = {
    label: {
      type: "string",
      description: "Brief description of what this call is doing (shown to the user)",
    },
  };
  for (const [name, schema] of Object.entries(entry.inputSchema.properties)) {
    if (name in fixedArgs) {
      continue;
    }
    properties[name] = sanitizeSchemaForModel(schema);
  }
  const required = ["label", ...entry.inputSchema.required.filter((name) => !(name in fixedArgs))];

  return {
    name: entry.name,
    label: humanizeName(entry.name),
    description: entry.description,
    parameters: { type: "object", properties, required, additionalProperties: false },
    execute: async (_toolCallId, rawParams, signal): Promise<PiToolResult> => {
      const { label: _label, ...params } = (rawParams ?? {}) as Record<string, unknown>;
      const args = { ...params, ...fixedArgs };
      try {
        const result = await dispatch(entry, args, client, { pathOverride, signal });
        const text = formatResult ? formatResult(result) : JSON.stringify(result, null, 2);
        return { content: [{ type: "text", text }], details: undefined };
      } catch (error) {
        // Deliberate divergence from the runtime's throw-on-failure contract:
        // errors are returned as tool-result text so the model can read the
        // failure (status, detail) and adapt — matching how the in-app agent's
        // existing query tools behave. Revisit if runtime error accounting
        // (isError marking) becomes load-bearing.
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error calling ${entry.name}: ${message}` }],
          details: undefined,
        };
      }
    },
  };
}
