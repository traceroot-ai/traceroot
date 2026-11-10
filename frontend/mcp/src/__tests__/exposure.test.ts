import { REGISTRY, type RegistryEntry } from "@traceroot-ai/tools";
import { describe, expect, it } from "vitest";
import { EXPOSED_TOOLS, exposedEntries } from "../exposure.js";

const annotations = {
  title: "T",
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

const entry = (overrides: Partial<RegistryEntry>): RegistryEntry => ({
  name: "thing",
  description: "",
  method: "get",
  path: "/x/{id}",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  annotations,
  ...overrides,
});

describe("exposure map", () => {
  it("exposes the 24 milestone-1 tools, each a live registry tool", () => {
    expect(EXPOSED_TOOLS).toHaveLength(24);
    expect(new Set(EXPOSED_TOOLS).size).toBe(24);
    expect(exposedEntries().map((e) => e.name)).toEqual([...EXPOSED_TOOLS]);
  });

  it("exposes only GETs and the two annotated read-only POSTs", () => {
    const posts = exposedEntries().filter((e) => e.method !== "get");
    expect(posts.map((e) => e.name).sort()).toEqual(["run_sql", "run_widget_query"]);
    for (const e of exposedEntries()) {
      expect(e.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it("fails on a name the registry does not have", () => {
    expect(() => exposedEntries(REGISTRY, ["no_such_tool"])).toThrow(/not in the registry/);
  });

  it("fails on a delete, a non-read POST, and an unannotated entry", () => {
    const del = entry({
      name: "delete_thing",
      method: "delete",
      annotations: { ...annotations, readOnlyHint: false, destructiveHint: true },
    });
    const post = entry({
      name: "make_thing",
      method: "post",
      annotations: { ...annotations, readOnlyHint: false },
    });
    const bare = entry({ name: "bare_thing", annotations: undefined });
    for (const e of [del, post, bare]) {
      expect(() => exposedEntries([e], [e.name]), e.name).toThrow(/not annotated read-only/);
    }
  });
});
