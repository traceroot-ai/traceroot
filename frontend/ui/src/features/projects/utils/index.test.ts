import { describe, it, expect } from "vitest";
import { projectSwitchHref } from "./index";

describe("projectSwitchHref", () => {
  it("preserves a top-level sub-page when switching projects", () => {
    expect(projectSwitchHref("/projects/abc/traces", "xyz")).toBe("/projects/xyz/traces");
    expect(projectSwitchHref("/projects/abc/sessions", "xyz")).toBe("/projects/xyz/sessions");
    expect(projectSwitchHref("/projects/abc/dashboard", "xyz")).toBe("/projects/xyz/dashboard");
  });

  it("preserves settings sub-pages (they exist for every project)", () => {
    expect(projectSwitchHref("/projects/abc/settings/general", "xyz")).toBe(
      "/projects/xyz/settings/general",
    );
    expect(projectSwitchHref("/projects/abc/settings/accessKeys", "xyz")).toBe(
      "/projects/xyz/settings/accessKeys",
    );
  });

  it("drops entity-specific segments below the sub-page", () => {
    expect(projectSwitchHref("/projects/abc/detectors/det-123", "xyz")).toBe(
      "/projects/xyz/detectors",
    );
    expect(projectSwitchHref("/projects/abc/detectors/new", "xyz")).toBe("/projects/xyz/detectors");
  });

  it("falls back to traces when not on a project sub-page", () => {
    expect(projectSwitchHref("/projects/abc", "xyz")).toBe("/projects/xyz/traces");
    expect(projectSwitchHref("/workspaces/ws-1/projects", "xyz")).toBe("/projects/xyz/traces");
    expect(projectSwitchHref("", "xyz")).toBe("/projects/xyz/traces");
  });
});
