import { describe, it, expect, vi } from "vitest";

const env = vi.hoisted(() => ({ LOOPS_ENABLED: "true" }));
vi.mock("@/env", () => ({ env }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import LoopsLayout from "./layout";

describe("Loops layout", () => {
  it("renders the Loop pages while LOOPS_ENABLED is on", () => {
    env.LOOPS_ENABLED = " TRUE ";
    expect(LoopsLayout({ children: "page" })).toBe("page");
  });

  it("is not found while LOOPS_ENABLED is off or unset", () => {
    for (const value of ["false", "", "1"]) {
      env.LOOPS_ENABLED = value;
      expect(() => LoopsLayout({ children: "page" })).toThrow("NEXT_NOT_FOUND");
    }
  });
});
