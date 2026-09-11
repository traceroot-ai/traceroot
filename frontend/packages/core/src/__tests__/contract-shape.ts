/**
 * Structural shape extraction for the cross-layer contract guard (Zod side).
 *
 * Fixture replay can only guard the constraints a fixture happens to exercise: add
 * an OPTIONAL field to one layer and every existing verdict is unchanged, so both
 * suites stay green while the two layers have silently diverged. This module reduces
 * each Zod schema to a language-neutral descriptor — property names, required set,
 * nullability, enum members, bounds, array item types, unknown-key policy — that is
 * compared against the checked-in roster in `eval-contract-shape.json`. The Pydantic
 * side derives the identical descriptor from `model_json_schema()` in
 * `tests/rest/test_eval_contract_parity.py`, so a field added, removed or retyped on
 * ONE layer fails that layer's roster comparison by construction.
 *
 * Both sides normalize away representational differences that carry no contract
 * meaning: `anyOf: [T, null]` collapses to `nullable`, a null/absent default is
 * dropped (Zod's absent-key `undefined` and pydantic's `None` default mean the same
 * "the caller omitted it"), and titles/descriptions are ignored.
 */
import { z } from "zod";

/** A type and its constraints, independent of where it appears. */
export type TypeShape = {
  type: string;
  enum?: readonly unknown[];
  const?: unknown;
  min_length?: number;
  max_length?: number;
  minimum?: number;
  maximum?: number;
  items?: TypeShape;
  min_items?: number;
  max_items?: number;
};

export type FieldShape = TypeShape & {
  required: boolean;
  nullable: boolean;
  default?: unknown;
};

export type ObjectShape = {
  kind: "object";
  /** `.strict()` / `extra="forbid"` → "forbid"; a plain object that strips → "strip". */
  unknown_keys: "forbid" | "strip";
  fields: Record<string, FieldShape>;
};

export type UnionShape = {
  kind: "discriminated_union";
  discriminator: string;
  variants: Record<string, ObjectShape>;
};

export type Shape = ObjectShape | UnionShape;

/** A JSON Schema node. Only the keywords both generators emit are read below. */
type JsonSchema = Record<string, unknown> & {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

const isNullNode = (node: JsonSchema) => node?.type === "null";

/** `anyOf: [T, null]` (either order) → `[T, true]`; anything else → `[node, false]`. */
function unwrapNullable(node: JsonSchema): [JsonSchema, boolean] {
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants) && variants.length === 2) {
    if (isNullNode(variants[1])) return [variants[0], true];
    if (isNullNode(variants[0])) return [variants[1], true];
  }
  return [node, false];
}

function refName(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

function put<T extends object>(target: T, key: string, value: unknown): void {
  if (value !== undefined) (target as Record<string, unknown>)[key] = value;
}

/**
 * `z.number().int()` is `Number.isSafeInteger`, so it publishes ±(2^53-1) bounds that
 * describe the JS number type rather than the wire contract; the gateway spells the
 * same ceiling as `JSON_SAFE_INT_MAX`. Both sides drop the sentinel so an integer
 * field compares on the bounds the contract actually chose (`minimum: 0`, `max: 5`).
 */
function sansSafeIntegerBound(value: unknown): unknown {
  return value === Number.MAX_SAFE_INTEGER || value === -Number.MAX_SAFE_INTEGER
    ? undefined
    : value;
}

/** Reduce one JSON Schema node to its language-neutral type descriptor. */
export function typeShape(node: JsonSchema): TypeShape {
  if (typeof node.$ref === "string") return { type: refName(node.$ref) };
  if (node.const !== undefined) return { type: "literal", const: node.const };
  if (Array.isArray(node.enum)) return { type: "enum", enum: [...node.enum] };

  switch (node.type) {
    case "string": {
      const shape: TypeShape = { type: "string" };
      put(shape, "min_length", node.minLength);
      put(shape, "max_length", node.maxLength);
      return shape;
    }
    case "integer":
    case "number": {
      const shape: TypeShape = { type: node.type };
      put(shape, "minimum", sansSafeIntegerBound(node.minimum));
      put(shape, "maximum", sansSafeIntegerBound(node.maximum));
      return shape;
    }
    case "boolean":
      return { type: "boolean" };
    case "array": {
      const shape: TypeShape = { type: "array", items: typeShape(node.items ?? {}) };
      put(shape, "min_items", node.minItems);
      put(shape, "max_items", node.maxItems);
      return shape;
    }
    case "object":
      // A free-form JSON object (a Zod record / a pydantic `dict[str, Any]`). Named
      // object models are always emitted as `$ref` and handled above.
      if (node.properties === undefined) return { type: "json_object" };
      throw new Error(`unnamed inline object: ${JSON.stringify(node).slice(0, 120)}`);
    case undefined:
      // `z.unknown()` / pydantic `Any` — an unconstrained JSON value.
      return { type: "any" };
  }
  throw new Error(`unsupported schema node: ${JSON.stringify(node).slice(0, 120)}`);
}

function objectShape(node: JsonSchema): ObjectShape {
  const required = new Set<string>(node.required ?? []);
  const fields: Record<string, FieldShape> = {};
  for (const [name, raw] of Object.entries<JsonSchema>(node.properties ?? {})) {
    const [inner, nullable] = unwrapNullable(raw);
    const field: FieldShape = {
      ...typeShape(inner),
      required: required.has(name),
      nullable,
    };
    // A null default is the absent-key default on both layers; only a real value
    // (`"evaluation"`, `[]`) is part of the contract.
    if (raw.default !== undefined && raw.default !== null) field.default = raw.default;
    fields[name] = field;
  }
  return {
    kind: "object",
    unknown_keys: node.additionalProperties === false ? "forbid" : "strip",
    fields,
  };
}

function unionShape(node: JsonSchema): UnionShape {
  const variants: Record<string, ObjectShape> = {};
  let discriminator: string | undefined;
  for (const variant of node.oneOf ?? node.anyOf ?? []) {
    const shape = objectShape(variant);
    const key = Object.entries(variant.properties ?? {}).find(
      ([, prop]) => (prop as JsonSchema).const !== undefined,
    );
    if (!key) throw new Error("discriminated union variant without a literal discriminator");
    discriminator = key[0];
    variants[String((key[1] as JsonSchema).const)] = shape;
  }
  return { kind: "discriminated_union", discriminator: discriminator!, variants };
}

/** True for the schemas the roster covers: object models and discriminated unions. */
function isModelSchema(value: unknown): value is z.ZodType {
  const type = (value as { _zod?: { def?: { type?: string } } })?._zod?.def?.type;
  return type === "object" || type === "union";
}

/**
 * Every exported `*Schema` object model in the contract module, keyed by model name
 * (the export name minus its `Schema` suffix, which is how the pydantic classes are
 * named). Enumerated from the module's exports rather than hand-listed, so a newly
 * added schema is covered — or fails the roster's coverage assertion — automatically.
 */
export function contractShapes(module: Record<string, unknown>): Record<string, Shape> {
  const models = Object.entries(module)
    .filter(([name, value]) => name.endsWith("Schema") && isModelSchema(value))
    .map(([name, value]) => [name.replace(/Schema$/, ""), value as z.ZodType] as const);

  // Registering ids makes `toJSONSchema` emit `$ref: "#/$defs/<ModelName>"` for a
  // nested model instead of inlining it, matching how pydantic names its `$defs`.
  for (const [name, schema] of models) {
    if (z.globalRegistry.get(schema)?.id !== name) z.globalRegistry.add(schema, { id: name });
  }

  const shapes: Record<string, Shape> = {};
  for (const [name, schema] of models) {
    const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
    shapes[name] = json.oneOf || json.anyOf ? unionShape(json) : objectShape(json);
  }
  return shapes;
}
