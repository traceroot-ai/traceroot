import { describe, it, expect } from "vitest";
import { workspaceSwitchHref } from "./index";

describe("workspaceSwitchHref", () => {
  it("preserves the current sub-page when switching workspaces", () => {
    expect(workspaceSwitchHref("/workspaces/abc/projects", "xyz")).toBe("/workspaces/xyz/projects");
    expect(workspaceSwitchHref("/workspaces/abc/settings/general", "xyz")).toBe(
      "/workspaces/xyz/settings/general",
    );
    expect(workspaceSwitchHref("/workspaces/abc/settings/integrations", "xyz")).toBe(
      "/workspaces/xyz/settings/integrations",
    );
  });

  it("falls back to the projects page when not on a workspace sub-page", () => {
    expect(workspaceSwitchHref("/workspaces/abc", "xyz")).toBe("/workspaces/xyz/projects");
    expect(workspaceSwitchHref("/projects/p-1/traces", "xyz")).toBe("/workspaces/xyz/projects");
    expect(workspaceSwitchHref("", "xyz")).toBe("/workspaces/xyz/projects");
  });
});
