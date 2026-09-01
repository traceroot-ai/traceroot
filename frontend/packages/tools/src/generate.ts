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

// Ref chains deeper than this are a schema bug (the write bodies nest a
// handful of levels at most), so the resolver fails instead of unbounded work.
const MAX_REF_DEPTH = 10;

/**
 * Recursively normalize one request-body property schema for the registry:
 * resolve `#/components/schemas/` $refs inline (bounded depth, cycle guard),
 * collapse `anyOf [T, null]` wrappers (optionality lives in `required`), strip
 * generated titles at every level, and stamp `type: "object"` on a union whose
 * variants are all objects — some model providers reject properties that
 * declare no `type`, and the stamped type is valid JSON Schema alongside the
 * preserved variants.
 *
 * `seenRefs` holds the ref names on the current resolution chain; revisiting
 * one is a cycle, which cannot be emitted inline and throws.
 */
function normalizeBodySchema(
  schema: Record<string, unknown>,
  doc: OpenApiDocument,
  path: string,
  seenRefs: ReadonlySet<string>,
): Record<string, unknown> {
  const { $ref, ...withoutRef } = schema;
  if (typeof $ref === "string") {
    if (seenRefs.size >= MAX_REF_DEPTH) {
      throw new Error(
        `Enabled tool on POST ${path}: $ref nesting exceeds ${MAX_REF_DEPTH} levels at ${$ref}`,
      );
    }
    const prefix = "#/components/schemas/";
    const name = $ref.startsWith(prefix) ? $ref.slice(prefix.length) : $ref;
    if (seenRefs.has(name)) {
      throw new Error(
        `Enabled tool on POST ${path}: cyclic $ref ${name} (via ${[...seenRefs].join(" -> ")})`,
      );
    }
    const resolved = resolveSchemaRef({ $ref }, doc, path);
    // Sibling keys next to the $ref (e.g. a description) override the target's.
    return normalizeBodySchema(
      { ...resolved, ...withoutRef },
      doc,
      path,
      new Set([...seenRefs, name]),
    );
  }
  const { title: _title, anyOf, ...rest } = withoutRef;
  const out: Record<string, unknown> = { ...rest };
  if (Array.isArray(anyOf)) {
    const variants = anyOf
      .map((variant) =>
        normalizeBodySchema(variant as Record<string, unknown>, doc, path, seenRefs),
      )
      .filter((variant) => variant.type !== "null");
    if (variants.length === 1) {
      return { ...variants[0], ...out };
    }
    out.anyOf = variants;
    if (out.type === undefined && variants.every((variant) => variant.type === "object")) {
      out.type = "object";
    }
  }
  if (out.properties !== null && typeof out.properties === "object") {
    out.properties = Object.fromEntries(
      Object.entries(out.properties as Record<string, Record<string, unknown>>).map(
        ([name, propSchema]) => [name, normalizeBodySchema(propSchema, doc, path, seenRefs)],
      ),
    );
  }
  if (out.items !== null && typeof out.items === "object" && !Array.isArray(out.items)) {
    out.items = normalizeBodySchema(out.items as Record<string, unknown>, doc, path, seenRefs);
  }
  return out;
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
      normalizeBodySchema(propSchema, doc, path, new Set()),
    );
    // The resolver reaches $refs at the property, items, and anyOf-variant
    // levels; one surviving anywhere else (e.g. allOf) would ship a dangling
    // pointer to the model. Fail closed until the generator learns the shape.
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
  approvalClass: ["none", "confirm", "approval"],
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
