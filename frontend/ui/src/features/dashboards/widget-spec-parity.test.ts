import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WidgetSpecSchema } from "./types";

/**
 * Cross-language parity guard: the pydantic WidgetSpec mirror the public API
 * validates with (surfaced through the committed public OpenAPI schema) must
 * stay structurally identical to the canonical zod WidgetSpecSchema the
 * dashboard renderer and write service parse with. A field, enum value, or
 * requiredness change on either side fails here until the other follows.
 *
 * The comparison is over a normalized "skeleton" — property names, types,
 * enums, required lists, nullability — deliberately ignoring titles,
 * descriptions, defaults, and length bounds, which the two generators emit
 * differently.
 */

const PUBLIC_JSON_URL = new URL("../../../../../backend/rest/openapi/public.json", import.meta.url);

interface Skeleton {
  types?: string[];
  nullable?: boolean;
  enum?: (string | number)[];
  required?: string[];
  properties?: Record<string, Skeleton>;
  items?: Skeleton;
  anyOf?: Skeleton[];
}

type SchemaNode = Record<string, unknown>;

/** Resolve `#/components/schemas/...` and `#/$defs/...` refs. */
function resolveRef(node: SchemaNode, defs: Record<string, SchemaNode>): SchemaNode {
  const ref = node.$ref;
  if (typeof ref !== "string") return node;
  const name = ref.split("/").pop()!;
  const target = defs[name];
  if (target === undefined) throw new Error(`unresolvable $ref in parity test: ${ref}`);
  return target;
}

function skeleton(rawNode: SchemaNode, defs: Record<string, SchemaNode>): Skeleton {
  const node = resolveRef(rawNode, defs);
  const out: Skeleton = {};

  // Union handling: fold null variants into a nullable flag; fold an
  // all-primitive union into a type set (pydantic emits `type: [a, b]`, zod an
  // anyOf of primitives — both normalize the same); keep object unions as an
  // ordered anyOf of skeletons.
  const anyOf = node.anyOf;
  if (Array.isArray(anyOf)) {
    const variants = (anyOf as SchemaNode[]).map((variant) => skeleton(variant, defs));
    const nonNull = variants.filter((v) => !(v.types?.length === 1 && v.types[0] === "null"));
    if (nonNull.length < variants.length) out.nullable = true;
    const structural = nonNull.some((v) => v.properties || v.items || v.enum || v.anyOf);
    if (!structural) {
      out.types = [...new Set(nonNull.flatMap((v) => v.types ?? []))].sort();
    } else if (nonNull.length === 1) {
      return { ...nonNull[0], ...(out.nullable ? { nullable: true } : {}) };
    } else {
      out.anyOf = nonNull.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return out;
  }

  const type = node.type;
  if (typeof type === "string") {
    out.types = [type];
  } else if (Array.isArray(type)) {
    const types = (type as string[]).filter((t) => t !== "null").sort();
    if (types.length < (type as string[]).length) out.nullable = true;
    out.types = types;
  }
  if (Array.isArray(node.enum)) out.enum = [...(node.enum as (string | number)[])].sort();
  if (node.const !== undefined) out.enum = [node.const as string | number];
  if (Array.isArray(node.required)) out.required = [...(node.required as string[])].sort();
  if (node.properties && typeof node.properties === "object") {
    out.properties = Object.fromEntries(
      Object.entries(node.properties as Record<string, SchemaNode>).map(([name, prop]) => [
        name,
        skeleton(prop, defs),
      ]),
    );
  }
  if (node.items && typeof node.items === "object" && !Array.isArray(node.items)) {
    out.items = skeleton(node.items as SchemaNode, defs);
  }
  return out;
}

describe("widget spec cross-language parity", () => {
  it("public.json's WidgetSpec component matches the canonical zod schema", () => {
    const publicDoc = JSON.parse(readFileSync(fileURLToPath(PUBLIC_JSON_URL), "utf8")) as {
      components: { schemas: Record<string, SchemaNode> };
    };
    const components = publicDoc.components.schemas;
    const pydanticSpec = components.WidgetSpec;
    expect(pydanticSpec).toBeDefined();

    // io: "input" — the write contract: fields with defaults are optional on
    // the way in (matching the pydantic request model), required only on output.
    const zodJson = z.toJSONSchema(WidgetSpecSchema, { io: "input" }) as SchemaNode;
    const zodDefs = (zodJson.$defs ?? {}) as Record<string, SchemaNode>;

    expect(skeleton(pydanticSpec, components)).toEqual(skeleton(zodJson, zodDefs));
  });
});
