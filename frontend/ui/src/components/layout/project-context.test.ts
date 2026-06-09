import { describe, it, expect } from "vitest";
import { getProjectContext } from "./project-context";

// The sidebar uses this to gate project-only items (Settings, the Upgrade button).
describe("getProjectContext", () => {
  it("detects a project route and extracts the project id", () => {
    expect(getProjectContext("/projects/abc123/traces")).toEqual({
      isProject: true,
      projectId: "abc123",
    });
    expect(getProjectContext("/projects/abc123")).toEqual({
      isProject: true,
      projectId: "abc123",
    });
    expect(getProjectContext("/projects/abc123/settings")).toEqual({
      isProject: true,
      projectId: "abc123",
    });
  });

  it("is not a project context on non-project routes", () => {
    expect(getProjectContext("/")).toEqual({ isProject: false, projectId: null });
    expect(getProjectContext("/workspaces")).toEqual({ isProject: false, projectId: null });
    expect(getProjectContext("/workspaces/ws1/settings/billing")).toEqual({
      isProject: false,
      projectId: null,
    });
    expect(getProjectContext("/support")).toEqual({ isProject: false, projectId: null });
  });

  it("is not a project context on the bare /projects path", () => {
    expect(getProjectContext("/projects")).toEqual({ isProject: false, projectId: null });
    expect(getProjectContext("/projects/")).toEqual({ isProject: false, projectId: null });
  });
});
