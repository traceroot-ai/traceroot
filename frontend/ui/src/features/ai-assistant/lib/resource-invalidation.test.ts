import { describe, expect, it } from "vitest";
import { invalidationKeysForResult } from "./resource-invalidation";

const writeResult = (details: Record<string, unknown>) => ({
  content: [{ type: "text", text: "Created something" }],
  details: { kind: "resource_created", created: true, ...details },
});

const dashboard = (overrides: Record<string, unknown> = {}) =>
  writeResult({ resourceType: "dashboard", resourceId: "db1", projectId: "p1", ...overrides });

const widget = (overrides: Record<string, unknown> = {}) =>
  writeResult({
    resourceType: "widget",
    resourceId: "w1",
    projectId: "p1",
    dashboardId: "db1",
    ...overrides,
  });

describe("invalidationKeysForResult", () => {
  it("stales the dashboards list and the new dashboard itself", () => {
    expect(invalidationKeysForResult(dashboard())).toEqual([
      ["dashboards", "p1"],
      ["dashboard", "p1", "db1"],
    ]);
  });

  it("stales the dashboards list and the parent dashboard for a widget", () => {
    // The placement write bumps the dashboard's update time, which the list
    // displays — so the list is stale too, not just the dashboard itself.
    expect(invalidationKeysForResult(widget())).toEqual([
      ["dashboards", "p1"],
      ["dashboard", "p1", "db1"],
    ]);
  });

  it("stales the coarse detectors key", () => {
    expect(
      invalidationKeysForResult(
        writeResult({ resourceType: "detector", resourceId: "d1", projectId: "p1" }),
      ),
    ).toEqual([["detectors"]]);
  });

  it("stales the workspace surfaces a new project appears on", () => {
    expect(
      invalidationKeysForResult(
        writeResult({ resourceType: "project", resourceId: "p9", workspaceId: "w1" }),
      ),
    ).toEqual([["workspaces"], ["projects", "w1"], ["workspace", "w1"]]);
  });

  it("stales the workspace list for a new workspace", () => {
    expect(
      invalidationKeysForResult(writeResult({ resourceType: "workspace", resourceId: "w9" })),
    ).toEqual([["workspaces"]]);
  });

  it("stales an idempotent (created:false) hit too — the row may not be cached", () => {
    expect(invalidationKeysForResult(dashboard({ created: false }))).toEqual([
      ["dashboards", "p1"],
      ["dashboard", "p1", "db1"],
    ]);
  });

  it("uses the result's own project, not any ambient one", () => {
    expect(invalidationKeysForResult(dashboard({ projectId: "p2" }))).toEqual([
      ["dashboards", "p2"],
      ["dashboard", "p2", "db1"],
    ]);
  });

  it("stales nothing when details are absent or malformed", () => {
    expect(invalidationKeysForResult(undefined)).toEqual([]);
    expect(invalidationKeysForResult({ content: [] })).toEqual([]);
    expect(invalidationKeysForResult({ details: "nope" })).toEqual([]);
    expect(invalidationKeysForResult(dashboard({ kind: "other" }))).toEqual([]);
    expect(invalidationKeysForResult(dashboard({ resourceId: 7 }))).toEqual([]);
  });

  it("stales nothing for a resource type it does not know", () => {
    expect(
      invalidationKeysForResult(writeResult({ resourceType: "sprocket", resourceId: "s1" })),
    ).toEqual([]);
  });

  it("stales nothing for a resource whose scoping ids are missing or not strings", () => {
    // Without a project there is no key to build; a bad type must not become one.
    expect(invalidationKeysForResult(dashboard({ projectId: undefined }))).toEqual([]);
    expect(invalidationKeysForResult(dashboard({ projectId: 7 }))).toEqual([]);
    expect(invalidationKeysForResult(widget({ dashboardId: undefined }))).toEqual([]);
    expect(invalidationKeysForResult(widget({ projectId: undefined }))).toEqual([]);
  });

  it("still stales the workspace list for a project with no workspace id", () => {
    expect(
      invalidationKeysForResult(writeResult({ resourceType: "project", resourceId: "p9" })),
    ).toEqual([["workspaces"]]);
  });
});
