import type { InputSchema, ParamSchema, RegistryEntry } from "./types.js";

interface OpenApiParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
  content?: Record<string, { schema?: Record<string, unknown> }>;
}

interface ToolCuration {
  enabled?: boolean;
  name?: string;
  description?: string;
}

interface OpenApiOperation {
  parameters?: OpenApiParameter[];
  "x-tool"?: ToolCuration;
}

export interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
}

/**
 * Flatten one plain (non-JSON-content) parameter schema: collapse FastAPI's
 * `anyOf [T, null]` wrapper for optional params into T and drop the generated
 * `title`, keeping every other constraint (format, bounds, default, ...).
 */
function flattenParamSchema(schema: Record<string, unknown> | undefined): ParamSchema {
  if (schema === undefined) {
    return {};
  }
  const {
    anyOf,
    title: _title,
    ...rest
  } = schema as {
    anyOf?: Record<string, unknown>[];
    title?: unknown;
  } & Record<string, unknown>;
  if (Array.isArray(anyOf)) {
    const variants = anyOf.filter((variant) => variant.type !== "null");
    if (variants.length === 1) {
      const { title: _variantTitle, ...variant } = variants[0]!;
      return { ...variant, ...rest };
    }
    // Multi-variant unions get the same treatment as single ones: drop the
    // null variant (optionality lives in `required`) and the noise titles.
    return {
      anyOf: variants.map(({ title: _variantTitle, ...variant }) => variant),
      ...rest,
    };
  }
  return rest;
}

/** Build the flat input schema for one operation's path + query parameters. */
function buildInputSchema(op: OpenApiOperation): InputSchema {
  const properties: Record<string, ParamSchema> = {};
  const required: string[] = [];
  for (const param of op.parameters ?? []) {
    if (param.in !== "query" && param.in !== "path") {
      continue;
    }
    const contentSchema = param.content?.["application/json"]?.schema;
    const flattened: ParamSchema =
      contentSchema !== undefined
        ? { ...contentSchema } // structured param: carry the schema verbatim
        : flattenParamSchema(param.schema); // plain param: flatten anyOf-null, strip title
    if (param.description !== undefined) {
      flattened.description = param.description;
    }
    properties[param.name] = flattened;
    if (param.required === true || param.in === "path") {
      required.push(param.name);
    }
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * Generate the tool registry from the public OpenAPI document: one entry per
 * operation whose x-tool curation is enabled, sorted by tool name. Only GET
 * operations are supported — write support must be a deliberate extension.
 */
export function generateRegistry(doc: OpenApiDocument): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(operations)) {
      const tool = op["x-tool"];
      if (tool?.enabled !== true) {
        continue;
      }
      if (method !== "get") {
        throw new Error(
          `Enabled tool on ${method.toUpperCase()} ${path}: only GET operations are supported`,
        );
      }
      if (tool.name === undefined || tool.description === undefined) {
        throw new Error(`Enabled tool on GET ${path} is missing an x-tool name or description`);
      }
      entries.push({
        name: tool.name,
        description: tool.description,
        method: "get",
        path,
        inputSchema: buildInputSchema(op),
      });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
