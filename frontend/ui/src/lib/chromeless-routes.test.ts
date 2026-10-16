import { describe, expect, it } from "vitest";
import { isChromelessRoute } from "./chromeless-routes";

describe("isChromelessRoute", () => {
  it("claims the sign-in surfaces and everything nested under them", () => {
    expect(isChromelessRoute("/auth/sign-in")).toBe(true);
    expect(isChromelessRoute("/auth/sign-up")).toBe(true);
    expect(isChromelessRoute("/auth/error")).toBe(true);
    expect(isChromelessRoute("/device")).toBe(true);
  });

  it("claims the onboarding flow and any step nested under it", () => {
    // Not for being reachable signed out — it is not — but because the shell's
    // navigation is the one thing a half-set-up account must not be offered.
    expect(isChromelessRoute("/onboarding")).toBe(true);
    expect(isChromelessRoute("/onboarding/project")).toBe(true);
  });

  it("claims a listed route with no sub-path of its own", () => {
    // There is no page at `/auth`, so this is Next's built-in 404 — which still
    // renders through the root layout. A not-found under the sign-in prefix has
    // no more business showing the workspace rail than a real sign-in page
    // does, so the boundary is drawn at the prefix rather than its children.
    expect(isChromelessRoute("/auth")).toBe(true);
  });

  it("leaves the rest of the app inside the shell", () => {
    expect(isChromelessRoute("/")).toBe(false);
    expect(isChromelessRoute("/workspaces")).toBe(false);
    expect(isChromelessRoute("/projects/p1/traces")).toBe(false);
    expect(isChromelessRoute("/account/settings")).toBe(false);
  });

  it("does not claim a route that merely starts with the same characters", () => {
    // The hazard a bare `startsWith` introduces: a real in-app page whose path
    // happens to share a prefix would lose its navigation entirely, and the
    // only symptom is a page with no way off it.
    expect(isChromelessRoute("/devices")).toBe(false);
    expect(isChromelessRoute("/device-settings")).toBe(false);
    expect(isChromelessRoute("/authorizations")).toBe(false);
    expect(isChromelessRoute("/onboarding-v2")).toBe(false);
  });
});
