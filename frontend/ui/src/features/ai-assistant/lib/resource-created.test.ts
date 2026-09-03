import { describe, expect, it } from "vitest";
import { resourceCreatedDetails } from "./resource-created";

const dashboardResult = (overrides: Record<string, unknown> = {}) => ({
  content: [{ type: "text", text: 'Created dashboard "Spend" (id db1)' }],
  details: {
    kind: "resource_created",
    resourceType: "dashboard",
    resourceId: "db1",
    created: true,
    projectId: "p1",
    ...overrides,
  },
});

describe("resourceCreatedDetails", () => {
  it("returns the details of a well-formed resource_created result", () => {
    expect(resourceCreatedDetails(dashboardResult())).toEqual({
      kind: "resource_created",
      resourceType: "dashboard",
      resourceId: "db1",
      created: true,
      projectId: "p1",
    });
  });

  it("passes every resource type through — consumers decide what to do with it", () => {
    for (const resourceType of ["workspace", "project", "detector", "widget"]) {
      expect(resourceCreatedDetails(dashboardResult({ resourceType }))?.resourceType).toBe(
        resourceType,
      );
    }
  });

  it("returns null for results without well-formed resource_created details", () => {
    expect(resourceCreatedDetails(undefined)).toBeNull();
    expect(resourceCreatedDetails(null)).toBeNull();
    expect(resourceCreatedDetails("Created dashboard db1")).toBeNull();
    expect(resourceCreatedDetails({ content: [] })).toBeNull();
    expect(resourceCreatedDetails({ details: "nope" })).toBeNull();
    expect(resourceCreatedDetails({ details: null })).toBeNull();
    expect(resourceCreatedDetails(dashboardResult({ kind: "other" }))).toBeNull();
    expect(resourceCreatedDetails(dashboardResult({ resourceId: 7 }))).toBeNull();
    expect(resourceCreatedDetails(dashboardResult({ resourceType: 7 }))).toBeNull();
    // "created" decides whether a card reads as created or reused, so a
    // non-boolean must not reach a consumer that only compares it to false.
    expect(resourceCreatedDetails(dashboardResult({ created: "false" }))).toBeNull();
    expect(resourceCreatedDetails(dashboardResult({ created: undefined }))).toBeNull();
  });
});
