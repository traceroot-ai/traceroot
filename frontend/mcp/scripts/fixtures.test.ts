/**
 * Every fixture the mock rest serves must be a response the public API could
 * send: it is checked against the route's 200 schema in public.json, so a
 * contract change that the fixtures miss fails here, not on the live run.
 *
 * The frontend has no JSON Schema validator as a direct dependency, so this is
 * a small one covering the keywords public.json uses for response shapes:
 * $ref, anyOf, type, const, enum, required, properties, additionalProperties
 * and items. A key a schema does not declare is an error, since the API's
 * response models drop undeclared keys.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROUTES } from "./mock-rest.js";

type Schema = {
  $ref?: string;
  anyOf?: Schema[];
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  items?: Schema;
};

const spec = JSON.parse(
  readFileSync(new URL("../../../backend/rest/openapi/public.json", import.meta.url), "utf8"),
) as {
  paths: Record<
    string,
    Record<
      string,
      { responses: { "200"?: { content: { "application/json": { schema: Schema } } } } }
    >
  >;
  components: { schemas: Record<string, Schema> };
};

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** Every mismatch between `value` and `schema`, as `path: reason`. */
export function validate(value: unknown, schema: Schema, path = "$"): string[] {
  if (schema.$ref) {
    const name = schema.$ref.replace("#/components/schemas/", "");
    return validate(value, spec.components.schemas[name]!, path);
  }
  if (schema.anyOf) {
    const branches = schema.anyOf.map((branch) => validate(value, branch, path));
    if (branches.some((errors) => errors.length === 0)) return [];
    // Report the branch whose type matched; when none did, say which types would.
    const typed = branches.filter((errors) => !errors[0]!.startsWith(`${path}: expected `));
    if (typed.length > 0) return typed.reduce((a, b) => (b.length < a.length ? b : a));
    const types = schema.anyOf.map((branch) => branch.type ?? branch.$ref?.split("/").pop());
    return [`${path}: expected ${types.join("|")}, got ${typeOf(value)}`];
  }
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === "integer" && allowed.includes("number"))) {
      return [`${path}: expected ${allowed.join("|")}, got ${actual}`];
    }
  }
  if ("const" in schema && value !== schema.const) {
    return [`${path}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return [`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`];
  }
  const errors: string[] = [];
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(item, schema.items!, `${path}[${i}]`)));
  }
  if (typeOf(value) === "object") {
    const record = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      if (!(name in record)) errors.push(`${path}: missing required ${name}`);
    }
    for (const [name, item] of Object.entries(record)) {
      const declared = schema.properties?.[name];
      if (declared) errors.push(...validate(item, declared, `${path}.${name}`));
      else if (typeof schema.additionalProperties === "object")
        errors.push(...validate(item, schema.additionalProperties, `${path}.${name}`));
      else if (schema.properties && schema.additionalProperties !== true)
        errors.push(`${path}: undeclared key ${name}`);
    }
  }
  return errors;
}

/** The 200 schema of the public.json operation a mock route stands in for. */
function responseSchema(method: string, route: string): Schema {
  const want = route.split("/");
  const entry = Object.entries(spec.paths).find(([path, ops]) => {
    const got = path.split("/");
    return (
      ops[method.toLowerCase()] !== undefined &&
      got.length === want.length &&
      got.every((part, i) => (want[i]!.startsWith(":") ? /^\{.+\}$/.test(part) : part === want[i]))
    );
  });
  if (entry === undefined) throw new Error(`${method} ${route} is not in public.json`);
  const ok = entry[1][method.toLowerCase()]!.responses["200"];
  if (ok === undefined) throw new Error(`${method} ${route} has no 200 response in public.json`);
  return ok.content["application/json"].schema;
}

describe("validate", () => {
  const schema: Schema = {
    type: "object",
    required: ["status"],
    properties: {
      status: { type: "string", enum: ["ACTIVE", "PAUSED"] },
      note: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  };

  it("accepts a conforming value", () => {
    expect(validate({ status: "ACTIVE", note: null }, schema)).toEqual([]);
  });

  it("reports a missing key, a bad enum, a wrong type and an undeclared key", () => {
    expect(validate({ note: 1, extra: true }, schema)).toEqual([
      "$: missing required status",
      "$.note: expected string|null, got integer",
      "$: undeclared key extra",
    ]);
    expect(validate({ status: "ok" }, schema)).toEqual([
      '$.status: "ok" is not one of ["ACTIVE","PAUSED"]',
    ]);
  });
});

describe("fixtures match the public API contract", () => {
  it.each(ROUTES.map(([method, route, answer]) => [`${method} ${route}`, method, route, answer]))(
    "%s",
    (_name, method, route, answer) => {
      const schema = responseSchema(method as string, route as string);
      const body = (answer as (body: unknown) => unknown)(undefined);
      expect(validate(body, schema)).toEqual([]);
    },
  );
});
