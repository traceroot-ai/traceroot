import { describe, expect, it } from "vitest";
import { NAV_HOME, NAV_GROUPS, isNavItemActive, navHref } from "./nav-items";

describe("project navigation", () => {
  it("groups the sections along the product loop: Observe, Detect, Verify", () => {
    expect(NAV_GROUPS.map((g) => [g.label, g.items.map((i) => i.label)])).toEqual([
      ["Observe", ["Tracing", "Dashboard"]],
      ["Detect", ["Detectors", "Signals", "Alerts"]],
      ["Verify", ["Datasets", "Evaluations"]],
    ]);
    expect(NAV_HOME.label).toBe("Agent");
  });

  it("covers every section exactly once", () => {
    const keys = [NAV_HOME, ...NAV_GROUPS.flatMap((g) => g.items)].map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(8);
  });

  it("builds project hrefs", () => {
    expect(navHref("p1", NAV_HOME)).toBe("/projects/p1/home");
    expect(navHref("p1", NAV_GROUPS[1].items[1])).toBe("/projects/p1/signals");
  });

  it("marks an item active on its own pages and their children", () => {
    const signals = NAV_GROUPS[1].items[1];
    expect(isNavItemActive("/projects/p1/signals", "p1", signals)).toBe(true);
    expect(isNavItemActive("/projects/p1/detectors/d1", "p1", NAV_GROUPS[1].items[0])).toBe(true);
    expect(isNavItemActive("/projects/p1/datasets/d9", "p1", NAV_GROUPS[2].items[0])).toBe(true);
    expect(isNavItemActive("/projects/p1/detectors", "p1", signals)).toBe(false);
  });

  it("keeps Tracing active on its sibling tabs (users, sessions)", () => {
    const tracing = NAV_GROUPS[0].items[0];
    for (const tab of ["traces", "users", "sessions"]) {
      expect(isNavItemActive(`/projects/p1/${tab}`, "p1", tracing)).toBe(true);
    }
  });
});
