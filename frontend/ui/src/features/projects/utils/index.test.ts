import { describe, it, expect } from "vitest";
import { projectSwitchHref, projectSectionLabel } from "./index";

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

describe("projectSectionLabel", () => {
  it("names a top-level project section by its navigation label", () => {
    expect(projectSectionLabel("/projects/p1/signals", "p1")).toBe("Signals");
    expect(projectSectionLabel("/projects/p1/traces", "p1")).toBe("Tracing");
    expect(projectSectionLabel("/projects/p1/home", "p1")).toBe("Home");
    expect(projectSectionLabel("/projects/p1/evaluations/", "p1")).toBe("Evaluations");
  });

  it("names the tracing tabs", () => {
    expect(projectSectionLabel("/projects/p1/users", "p1")).toBe("Users");
    expect(projectSectionLabel("/projects/p1/sessions", "p1")).toBe("Sessions");
  });

  it("has no label for nested or unknown pages, which name themselves", () => {
    expect(projectSectionLabel("/projects/p1/detectors/d1", "p1")).toBeUndefined();
    expect(projectSectionLabel("/projects/p1/settings", "p1")).toBeUndefined();
    expect(projectSectionLabel("/projects/other/signals", "p1")).toBeUndefined();
  });
});
