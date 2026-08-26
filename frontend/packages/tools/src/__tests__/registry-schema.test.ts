import { describe, expect, it } from "vitest";
import { REGISTRY } from "../registry.generated.js";

/** Collect "tool.path" for every property schema that declares no `type`. */
function untypedProperties(node: unknown, path: string, acc: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => untypedProperties(item, `${path}[${i}]`, acc));
    return;
  }
  if (node === null || typeof node !== "object") return;
  const schema = node as Record<string, unknown>;
  if (schema.properties && typeof schema.properties === "object") {
    for (const [name, prop] of Object.entries(schema.properties as Record<string, unknown>)) {
      if (!(prop as Record<string, unknown>).type) acc.push(`${path}.${name}`);
      untypedProperties(prop, `${path}.${name}`, acc);
    }
  }
  for (const key of ["items", "anyOf", "allOf", "oneOf"]) {
    if (key in schema) untypedProperties(schema[key], `${path}.${key}`, acc);
  }
}

describe("registry tool schemas", () => {
  // Some model providers reject tool parameters whose properties carry only
  // const/enum without a type; the public schema emits a type everywhere.
  it("declare a type on every property", () => {
    const missing: string[] = [];
    for (const entry of REGISTRY) {
      untypedProperties(entry.inputSchema, entry.name, missing);
    }
    expect(missing).toEqual([]);
  });
});
