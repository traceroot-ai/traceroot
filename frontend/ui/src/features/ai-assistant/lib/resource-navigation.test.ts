import { describe, expect, it } from "vitest";
import { createdDashboardRoute } from "./resource-navigation";

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

const ctx = {
  eventSessionId: "s1",
  activeSessionId: "s1" as string | null,
  panelProjectId: "p1" as string | undefined,
};

describe("createdDashboardRoute", () => {
  it("routes to the created dashboard for an active-session, same-project result", () => {
    expect(createdDashboardRoute({ result: dashboardResult(), ...ctx })).toBe(
      "/projects/p1/dashboard/db1",
    );
  });

  it("routes for a reused (created:false) dashboard too", () => {
    expect(createdDashboardRoute({ result: dashboardResult({ created: false }), ...ctx })).toBe(
      "/projects/p1/dashboard/db1",
    );
  });

  it("does not route when the result's project differs from the panel's", () => {
    expect(
      createdDashboardRoute({ result: dashboardResult({ projectId: "p2" }), ...ctx }),
    ).toBeNull();
    expect(
      createdDashboardRoute({ result: dashboardResult(), ...ctx, panelProjectId: undefined }),
    ).toBeNull();
  });

  it("does not route for events from a non-active session", () => {
    expect(
      createdDashboardRoute({ result: dashboardResult(), ...ctx, activeSessionId: "s2" }),
    ).toBeNull();
    expect(
      createdDashboardRoute({ result: dashboardResult(), ...ctx, activeSessionId: null }),
    ).toBeNull();
  });

  it("does not route for any other created resource type", () => {
    for (const resourceType of ["workspace", "project", "detector", "widget"]) {
      expect(
        createdDashboardRoute({
          result: dashboardResult({ resourceType, dashboardId: "db1" }),
          ...ctx,
        }),
      ).toBeNull();
    }
  });

  it("ignores results without well-formed resource_created details", () => {
    expect(createdDashboardRoute({ result: undefined, ...ctx })).toBeNull();
    expect(createdDashboardRoute({ result: { content: [] }, ...ctx })).toBeNull();
    expect(createdDashboardRoute({ result: { details: "nope" }, ...ctx })).toBeNull();
    expect(
      createdDashboardRoute({ result: dashboardResult({ resourceId: 7 }), ...ctx }),
    ).toBeNull();
    expect(
      createdDashboardRoute({ result: dashboardResult({ kind: "other" }), ...ctx }),
    ).toBeNull();
  });
});
