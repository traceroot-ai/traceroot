import { stripOversizedNumericBounds } from "./sanitize.js";
import type { InputSchema, ParamSchema, RegistryEntry, ToolMethod, ToolPolicy } from "./types.js";

/**
 * Verbs an enabled operation may use. `put` (full replacement: the caller
 * sends the whole resource and the server stores exactly that) is the expected
 * next one, not a rejected one. Adding it is one more member on `ToolMethod`,
 * one more entry here, and a `replace_x` curation entry per resource on the
 * same service as its `update_x`; it takes the POST branch of the body
 * flattening, because a complete body has nothing to clear and needs no null
 * rule.
 */
const SUPPORTED_METHODS: readonly ToolMethod[] = ["get", "post", "patch", "delete"];

function isSupportedMethod(method: string): method is ToolMethod {
  return (SUPPORTED_METHODS as readonly string[]).includes(method);
}

/** Verbs whose operations carry a JSON request body. */
type BodyMethod = "post" | "patch";

/**
 * What the body helpers need to know about the operation they flatten: the
 * verb decides the null rule, and every error names the route.
 */
interface BodyContext {
  method: BodyMethod;
  doc: OpenApiDocument;
  /** `"PATCH /api/v1/public/dashboards/{dashboard_id}"`, for error messages. */
  route: string;
}

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
 * True for the null branch of a nullable union. OpenAPI emitters spell it
 * either as `{type: "null"}` or as `{const: null}`; both mean the same thing.
 */
function isNullVariant(variant: Record<string, unknown>): boolean {
  return variant.type === "null" || variant.const === null;
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
    const variants = anyOf.filter((variant) => !isNullVariant(variant));
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
  ctx: BodyContext,
): Record<string, unknown> {
  const ref = schema.$ref;
  if (typeof ref !== "string") {
    return schema;
  }
  const prefix = "#/components/schemas/";
  const resolved = ref.startsWith(prefix)
    ? ctx.doc.components?.schemas?.[ref.slice(prefix.length)]
    : undefined;
  if (resolved === undefined) {
    throw new Error(`Enabled tool on ${ctx.route}: unresolvable requestBody $ref ${ref}`);
  }
  return resolved;
}

// Ref chains deeper than this are a schema bug (the write bodies nest a
// handful of levels at most), so the resolver fails instead of unbounded work.
const MAX_REF_DEPTH = 10;

/**
 * Apply the null rule to a body schema that admitted `null` in the source.
 * On a PATCH an explicit null means clear, so the emitted schema must say
 * null is legal: its `type` becomes a list ending in `"null"` — a type list,
 * never a bare anyOf, because some model providers reject typeless tool
 * parameters. Keywords that constrain every value are widened alongside,
 * since a validator applies them to null too: `enum` gains a null member and
 * a preserved `anyOf` gains a `{type: "null"}` variant. On a POST the null
 * variant is simply dropped: optionality lives in `required`, and a create
 * has no stored value to clear.
 *
 * A nullable PATCH schema this cannot widen — no `type`, or a `const`,
 * `oneOf` or `allOf` that would still reject null — fails closed rather than
 * silently shipping a field the model cannot clear.
 */
function admitNull(schema: Record<string, unknown>, ctx: BodyContext): Record<string, unknown> {
  if (ctx.method !== "patch") {
    return schema;
  }
  const cannotWiden = new Error(
    `Enabled tool on ${ctx.route}: nullable body schema cannot be widened with "null" ` +
      "(it needs a type and no const, oneOf or allOf) — extend the generator before enabling " +
      "this operation",
  );
  const { type, enum: enumValues, anyOf } = schema;
  if ("const" in schema || "oneOf" in schema || "allOf" in schema) {
    throw cannotWiden;
  }
  let widenedType: string[];
  if (typeof type === "string") {
    widenedType = [type, "null"];
  } else if (Array.isArray(type) && type.length > 0) {
    widenedType = type.includes("null") ? (type as string[]) : [...(type as string[]), "null"];
  } else {
    throw cannotWiden;
  }
  const out: Record<string, unknown> = { ...schema, type: widenedType };
  if (Array.isArray(enumValues) && !enumValues.includes(null)) {
    out.enum = [...enumValues, null];
  }
  if (Array.isArray(anyOf) && !anyOf.some((variant) => isNullVariant(variant))) {
    out.anyOf = [...anyOf, { type: "null" }];
  }
  return out;
}

/**
 * Recursively normalize one request-body property schema for the registry:
 * resolve `#/components/schemas/` $refs inline (bounded depth, cycle guard),
 * unwrap `anyOf [T, null]` (dropping the null on a POST, widening T's type
 * with `"null"` on a PATCH — see `admitNull`), strip generated titles at every
 * level, and stamp `type: "object"` on a union whose variants are all objects
 * — some model providers reject properties that declare no `type`, and the
 * stamped type is valid JSON Schema alongside the preserved variants.
 *
 * `seenRefs` holds the ref names on the current resolution chain; revisiting
 * one is a cycle, which cannot be emitted inline and throws.
 */
function normalizeBodySchema(
  schema: Record<string, unknown>,
  ctx: BodyContext,
  seenRefs: ReadonlySet<string>,
): Record<string, unknown> {
  const { $ref, ...withoutRef } = schema;
  if (typeof $ref === "string") {
    if (seenRefs.size >= MAX_REF_DEPTH) {
      throw new Error(
        `Enabled tool on ${ctx.route}: $ref nesting exceeds ${MAX_REF_DEPTH} levels at ${$ref}`,
      );
    }
    const prefix = "#/components/schemas/";
    const name = $ref.startsWith(prefix) ? $ref.slice(prefix.length) : $ref;
    if (seenRefs.has(name)) {
      throw new Error(
        `Enabled tool on ${ctx.route}: cyclic $ref ${name} (via ${[...seenRefs].join(" -> ")})`,
      );
    }
    const resolved = resolveSchemaRef({ $ref }, ctx);
    // Sibling keys next to the $ref (e.g. a description) override the target's.
    return normalizeBodySchema({ ...resolved, ...withoutRef }, ctx, new Set([...seenRefs, name]));
  }
  const { title: _title, anyOf, ...rest } = withoutRef;
  const out: Record<string, unknown> = { ...rest };
  let nullable = false;
  if (Array.isArray(anyOf)) {
    const normalized = anyOf.map((variant) =>
      normalizeBodySchema(variant as Record<string, unknown>, ctx, seenRefs),
    );
    const variants = normalized.filter((variant) => !isNullVariant(variant));
    nullable = variants.length < normalized.length;
    if (variants.length === 1) {
      const merged = { ...variants[0], ...out };
      return nullable ? admitNull(merged, ctx) : merged;
    }
    out.anyOf = variants;
    if (out.type === undefined && variants.every((variant) => variant.type === "object")) {
      out.type = "object";
    }
  }
  if (out.properties !== null && typeof out.properties === "object") {
    out.properties = Object.fromEntries(
      Object.entries(out.properties as Record<string, Record<string, unknown>>).map(
        ([name, propSchema]) => [name, normalizeBodySchema(propSchema, ctx, seenRefs)],
      ),
    );
  }
  if (out.items !== null && typeof out.items === "object" && !Array.isArray(out.items)) {
    out.items = normalizeBodySchema(out.items as Record<string, unknown>, ctx, seenRefs);
  }
  return nullable ? admitNull(out, ctx) : out;
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
 * Merge a POST or PATCH operation's JSON request-body properties into its
 * input schema (flattened like plain params) and append the body's required
 * names. Returns the body-derived property names, sorted, for arg-to-body
 * routing.
 */
function mergeBodySchema(op: OpenApiOperation, ctx: BodyContext, input: InputSchema): string[] {
  const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
  if (bodySchema === undefined) {
    return [];
  }
  const resolved = resolveSchemaRef(bodySchema, ctx);
  // A resolved body schema without top-level properties is a shape the
  // generator does not understand (a union body, a $ref alias, an allOf
  // wrapper): emitting empty bodyParams would ship a write tool that sends no
  // body at all. Fail closed like every other unexpected body shape.
  if (
    resolved.properties === undefined ||
    resolved.properties === null ||
    typeof resolved.properties !== "object" ||
    Array.isArray(resolved.properties)
  ) {
    throw new Error(
      `Enabled tool on ${ctx.route}: request-body schema has no top-level properties — ` +
        "extend the generator before enabling this operation",
    );
  }
  const properties = resolved.properties as Record<string, Record<string, unknown>>;
  for (const [name, propSchema] of Object.entries(properties)) {
    const flattened = stripOversizedNumericBounds(normalizeBodySchema(propSchema, ctx, new Set()));
    // The resolver reaches $refs at the property, items, and anyOf-variant
    // levels; one surviving anywhere else (e.g. allOf) would ship a dangling
    // pointer to the model. Fail closed until the generator learns the shape.
    if (containsRef(flattened)) {
      throw new Error(
        `Enabled tool on ${ctx.route}: body property "${name}" contains an unresolved $ref — extend the generator before enabling this operation`,
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
function validatePolicy(policy: unknown, route: string): ToolPolicy {
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
      `Enabled write tool on ${route}: x-tool policy {approvalClass, minRole, tenancy} is required and must be complete`,
    );
  }
  return { ...(candidate as unknown as ToolPolicy) };
}

/**
 * Generate the tool registry from the public OpenAPI document: one entry per
 * operation whose x-tool curation is enabled, sorted by tool name. GET, POST,
 * PATCH and DELETE operations are supported (see `SUPPORTED_METHODS` for the
 * PUT note); every enabled write must carry a complete x-tool policy so no
 * write tool ships without explicit guardrails. POST and PATCH bodies are
 * flattened into the input schema; a DELETE has no body, so its arguments are
 * path and query parameters like a GET's.
 */
export function generateRegistry(doc: OpenApiDocument): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(operations)) {
      const tool = op["x-tool"];
      if (tool?.enabled !== true) {
        continue;
      }
      const route = `${method.toUpperCase()} ${path}`;
      if (!isSupportedMethod(method)) {
        throw new Error(
          `Enabled tool on ${route}: only GET, POST, PATCH and DELETE operations are supported` +
            (method === "put" ? " (PUT is not supported yet)" : ""),
        );
      }
      if (tool.name === undefined || tool.description === undefined) {
        throw new Error(`Enabled tool on ${route} is missing an x-tool name or description`);
      }
      const inputSchema = buildInputSchema(op);
      if (method === "get") {
        // The policy vocabulary is write-only. The schema build rejects a GET
        // that carries one, so reject it here too rather than silently
        // dropping it and letting the two generators disagree.
        if (tool.policy !== undefined) {
          throw new Error(`Enabled read tool on ${route}: x-tool policy is write-only`);
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
      const policy = validatePolicy(tool.policy, route);
      let bodyParams: string[] | undefined;
      if (method === "delete") {
        // The public surface keeps DELETE bodies off the wire (the path id
        // and tenancy travel in the path and query). Ignoring a declared body
        // would ship a tool that silently drops arguments, so fail closed.
        if (op.requestBody !== undefined) {
          throw new Error(
            `Enabled tool on ${route}: DELETE operations take no request body — ` +
              "declare its arguments as path or query parameters",
          );
        }
      } else {
        bodyParams = mergeBodySchema(op, { method, doc, route }, inputSchema);
      }
      // Copied verbatim: hidden fields stay in inputSchema/bodyParams (full
      // API/CLI parity) — stripping them from the model is the consumer's job.
      const agentHiddenParams = tool.agentHiddenParams;
      for (const field of agentHiddenParams ?? []) {
        if (!(bodyParams ?? []).includes(field)) {
          throw new Error(
            `Enabled write tool on ${route}: agentHiddenParams field "${field}" is not a request-body property`,
          );
        }
      }
      entries.push({
        name: tool.name,
        description: tool.description,
        method,
        path,
        inputSchema,
        ...(bodyParams !== undefined && { bodyParams }),
        ...(agentHiddenParams !== undefined && { agentHiddenParams }),
        policy,
      });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
