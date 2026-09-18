import { describe, expect, it } from "vitest";
import {
  resourceCreatedDetails,
  resourceDeletedDetails,
  resourceUpdatedDetails,
} from "./resource-created";

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

  it("keeps the created name and what it was renamed from, when the details carry them", () => {
    const details = resourceCreatedDetails(
      dashboardResult({ name: "Spend (2)", renamedFrom: "Spend" }),
    );
    expect(details).toMatchObject({ name: "Spend (2)", renamedFrom: "Spend" });
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

const updatedResult = (overrides: Record<string, unknown> = {}) => ({
  content: [{ type: "text", text: 'Updated detector "Timeouts" (id d1) — changed: name' }],
  details: {
    kind: "resource_updated",
    resourceType: "detector",
    resourceId: "d1",
    name: "Timeouts",
    changed: ["name"],
    projectId: "p1",
    ...overrides,
  },
});

const deletedResult = (overrides: Record<string, unknown> = {}) => ({
  content: [{ type: "text", text: 'Deleted widget "Errors" (id w1) — reason: duplicate' }],
  details: {
    kind: "resource_deleted",
    resourceType: "widget",
    resourceId: "w1",
    name: "Errors",
    reason: "duplicate",
    projectId: "p1",
    ...overrides,
  },
});

describe("resourceUpdatedDetails", () => {
  it("returns the details of a well-formed resource_updated result, flags included", () => {
    expect(resourceUpdatedDetails(updatedResult({ stateReset: true, pageCleared: false }))).toEqual(
      {
        kind: "resource_updated",
        resourceType: "detector",
        resourceId: "d1",
        name: "Timeouts",
        changed: ["name"],
        projectId: "p1",
        stateReset: true,
        pageCleared: false,
      },
    );
  });

  it("accepts an empty changed list — a no-op edit is still an update receipt", () => {
    expect(resourceUpdatedDetails(updatedResult({ changed: [] }))?.changed).toEqual([]);
  });

  it("returns null for anything that is not a well-formed resource_updated result", () => {
    expect(resourceUpdatedDetails(undefined)).toBeNull();
    expect(resourceUpdatedDetails({ details: null })).toBeNull();
    expect(resourceUpdatedDetails(dashboardResult())).toBeNull();
    expect(resourceUpdatedDetails(updatedResult({ resourceId: 7 }))).toBeNull();
    expect(resourceUpdatedDetails(updatedResult({ resourceType: null }))).toBeNull();
    // changed is what the receipt lists; a malformed one must not reach a consumer.
    expect(resourceUpdatedDetails(updatedResult({ changed: "name" }))).toBeNull();
    expect(resourceUpdatedDetails(updatedResult({ changed: ["name", 7] }))).toBeNull();
    expect(resourceUpdatedDetails(updatedResult({ changed: undefined }))).toBeNull();
  });
});

describe("resourceDeletedDetails", () => {
  it("returns the details of a well-formed resource_deleted result", () => {
    expect(
      resourceDeletedDetails(deletedResult({ cascaded: { widgets: 3 }, pageCleared: true })),
    ).toEqual({
      kind: "resource_deleted",
      resourceType: "widget",
      resourceId: "w1",
      name: "Errors",
      reason: "duplicate",
      projectId: "p1",
      cascaded: { widgets: 3 },
      pageCleared: true,
    });
  });

  it("returns null for anything that is not a well-formed resource_deleted result", () => {
    expect(resourceDeletedDetails(undefined)).toBeNull();
    expect(resourceDeletedDetails("Deleted widget w1")).toBeNull();
    expect(resourceDeletedDetails(updatedResult())).toBeNull();
    expect(resourceDeletedDetails(deletedResult({ resourceId: 7 }))).toBeNull();
    // The reason is what the card quotes; a missing one is not a delete receipt.
    expect(resourceDeletedDetails(deletedResult({ reason: undefined }))).toBeNull();
    expect(resourceDeletedDetails(deletedResult({ reason: 7 }))).toBeNull();
  });

  it("returns null when the cascade is not counts by name — the card reads it as such", () => {
    expect(resourceDeletedDetails(deletedResult({ cascaded: null }))).toBeNull();
    expect(resourceDeletedDetails(deletedResult({ cascaded: [3] }))).toBeNull();
    expect(resourceDeletedDetails(deletedResult({ cascaded: "3 widgets" }))).toBeNull();
    expect(resourceDeletedDetails(deletedResult({ cascaded: { widgets: "3" } }))).toBeNull();
    expect(resourceDeletedDetails(deletedResult({ cascaded: { widgets: NaN } }))).toBeNull();
    // No cascade at all is a delete of a leaf resource.
    expect(
      resourceDeletedDetails(deletedResult({ cascaded: undefined }))?.cascaded,
    ).toBeUndefined();
    expect(resourceDeletedDetails(deletedResult({ cascaded: {} }))?.cascaded).toEqual({});
  });
});
