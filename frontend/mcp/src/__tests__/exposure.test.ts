import { REGISTRY, type RegistryEntry } from "@traceroot-ai/tools";
import { describe, expect, it } from "vitest";
import { EXPOSED_TOOLS, QUERY_ONLY_POSTS, exposedEntries } from "../exposure.js";

describe("exposure map", () => {
  it("exposes the 24 milestone-1 tools, each a live registry tool", () => {
    expect(EXPOSED_TOOLS).toHaveLength(24);
    expect(new Set(EXPOSED_TOOLS).size).toBe(24);
    expect(exposedEntries().map((entry) => entry.name)).toEqual([...EXPOSED_TOOLS]);
  });

  it("exposes only GETs and the declared query-only POSTs", () => {
    for (const entry of exposedEntries()) {
      expect(entry.method === "get" || QUERY_ONLY_POSTS.has(entry.name)).toBe(true);
    }
  });

  it("declares query-only only for POSTs that are exposed", () => {
    for (const name of QUERY_ONLY_POSTS) {
      expect(EXPOSED_TOOLS).toContain(name);
      expect(REGISTRY.find((entry) => entry.name === name)?.method).toBe("post");
    }
  });

  it("fails on a name the registry does not have", () => {
    expect(() => exposedEntries(REGISTRY, ["no_such_tool"])).toThrow(/not in the registry/);
  });

  it("fails on a write tool", () => {
    const write: RegistryEntry = {
      name: "delete_thing",
      description: "",
      method: "delete",
      path: "/x/{id}",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      policy: { approvalClass: "approval", minRole: "ADMIN", tenancy: "project" },
    };
    expect(() => exposedEntries([write], ["delete_thing"])).toThrow(/reads only/);
  });
});
