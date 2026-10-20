import { describe, it, expect } from "vitest";
import { homeDestination } from "./index";

describe("homeDestination", () => {
  it("sends a user with no workspace to onboarding", () => {
    expect(homeDestination([])).toBe("/onboarding");
  });

  it("sends a new user who has only the demo workspace to onboarding", () => {
    expect(homeDestination([{ is_demo: true }])).toBe("/onboarding");
  });

  it("sends a user with their own workspace to the workspace list", () => {
    expect(homeDestination([{ is_demo: false }, { is_demo: true }])).toBe("/workspaces");
    expect(homeDestination([{}])).toBe("/workspaces");
  });
});
