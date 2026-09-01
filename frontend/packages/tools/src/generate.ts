import { stripOversizedNumericBounds } from "./sanitize.js";
import type { InputSchema, ParamSchema, RegistryEntry, ToolPolicy } from "./types.js";

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
  policy?: unknown;
  agentHiddenParams?: readonly string[];
}

interface OpenApiOperation {
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
  "x-tool"?: ToolCuration;
}

export interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, Record<string, unknown>> };
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
    // Column-range maxima are API-correct but break OpenAI tools; see sanitize.ts.
    properties[param.name] = stripOversizedNumericBounds(flattened);
    if (param.required === true || param.in === "path") {
      required.push(param.name);
    }
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * Resolve a `#/components/schemas/...` $ref against the document, one level.
 * Non-ref schemas pass through untouched; a ref that cannot be resolved is a
 * schema bug and throws rather than silently emitting an empty input schema.
 */
function resolveSchemaRef(
  schema: Record<string, unknown>,
  doc: OpenApiDocument,
  path: string,
): Record<string, unknown> {
  const ref = schema.$ref;
  if (typeof ref !== "string") {
    return schema;
  }
  const prefix = "#/components/schemas/";
  const resolved = ref.startsWith(prefix)
    ? doc.components?.schemas?.[ref.slice(prefix.length)]
    : undefined;
  if (resolved === undefined) {
    throw new Error(`Enabled tool on POST ${path}: unresolvable requestBody $ref ${ref}`);
  }
  return resolved;
}

/** True when a `$ref` key survives anywhere in an emitted schema fragment. */
function containsRef(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(containsRef);
  }
  if (node === null || typeof node !== "object") {
    return false;
  }
  const record = node as Record<string, unknown>;
  return "$ref" in record || Object.values(record).some(containsRef);
}

/**
 * Merge a POST operation's JSON request-body properties into its input schema
 * (flattened like plain params) and append the body's required names. Returns
 * the body-derived property names, sorted, for arg-to-body routing.
 */
function mergeBodySchema(
  op: OpenApiOperation,
  doc: OpenApiDocument,
  path: string,
  input: InputSchema,
): string[] {
  const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
  if (bodySchema === undefined) {
    return [];
  }
  const resolved = resolveSchemaRef(bodySchema, doc, path);
  const properties = (resolved.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, propSchema] of Object.entries(properties)) {
    const flattened = stripOversizedNumericBounds(
      flattenParamSchema(resolveSchemaRef(propSchema, doc, path)),
    );
    // Refs are only resolved one level deep, so a nested $ref (e.g. inside
    // `items`) would ship a dangling pointer to the model. Fail closed until
    // the generator learns to resolve the shape an operation actually needs.
    if (containsRef(flattened)) {
      throw new Error(
        `Enabled tool on POST ${path}: body property "${name}" contains an unresolved $ref — extend the generator before enabling this operation`,
      );
    }
    input.properties[name] = flattened;
  }
  if (Array.isArray(resolved.required)) {
    input.required.push(...(resolved.required as string[]));
  }
  return Object.keys(properties).sort();
}

const POLICY_VALUES: Record<keyof ToolPolicy, readonly string[]> = {
  approvalClass: ["none", "approval"],
  minRole: ["VIEWER", "MEMBER", "ADMIN"],
  tenancy: ["account", "workspace", "project"],
};

/**
 * Require a complete, exact x-tool policy on a write operation: the three
 * policy keys with legal values and nothing else, so both codegen sides stay
 * honest about what a write tool is allowed to do.
 */
function validatePolicy(policy: unknown, path: string): ToolPolicy {
  const keys = Object.keys(POLICY_VALUES) as (keyof ToolPolicy)[];
  const candidate = policy as Record<string, unknown> | null;
  const valid =
    typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate) &&
    Object.keys(candidate).length === keys.length &&
    keys.every((key) => POLICY_VALUES[key].includes(candidate[key] as string));
  if (!valid) {
    throw new Error(
      `Enabled write tool on POST ${path}: x-tool policy {approvalClass, minRole, tenancy} is required and must be complete`,
    );
  }
  return { ...(candidate as unknown as ToolPolicy) };
}

/**
 * Generate the tool registry from the public OpenAPI document: one entry per
 * operation whose x-tool curation is enabled, sorted by tool name. GET and
 * POST operations are supported; every enabled POST must carry a complete
 * x-tool policy so no write tool ships without explicit guardrails.
 */
export function generateRegistry(doc: OpenApiDocument): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(operations)) {
      const tool = op["x-tool"];
      if (tool?.enabled !== true) {
        continue;
      }
      if (method !== "get" && method !== "post") {
        throw new Error(
          `Enabled tool on ${method.toUpperCase()} ${path}: only GET and POST operations are supported`,
        );
      }
      if (tool.name === undefined || tool.description === undefined) {
        throw new Error(
          `Enabled tool on ${method.toUpperCase()} ${path} is missing an x-tool name or description`,
        );
      }
      const inputSchema = buildInputSchema(op);
      if (method === "get") {
        // The policy vocabulary is write-only. The schema build rejects a GET
        // that carries one, so reject it here too rather than silently
        // dropping it and letting the two generators disagree.
        if (tool.policy !== undefined) {
          throw new Error(`Enabled read tool on GET ${path}: x-tool policy is write-only`);
        }
        entries.push({
          name: tool.name,
          description: tool.description,
          method: "get",
          path,
          inputSchema,
        });
        continue;
      }
      const policy = validatePolicy(tool.policy, path);
      const bodyParams = mergeBodySchema(op, doc, path, inputSchema);
      // Copied verbatim: hidden fields stay in inputSchema/bodyParams (full
      // API/CLI parity) — stripping them from the model is the consumer's job.
      const agentHiddenParams = tool.agentHiddenParams;
      for (const field of agentHiddenParams ?? []) {
        if (!bodyParams.includes(field)) {
          throw new Error(
            `Enabled write tool on POST ${path}: agentHiddenParams field "${field}" is not a request-body property`,
          );
        }
      }
      entries.push({
        name: tool.name,
        description: tool.description,
        method: "post",
        path,
        inputSchema,
        bodyParams,
        ...(agentHiddenParams !== undefined && { agentHiddenParams }),
        policy,
      });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
