import { describe, it, expect } from "vitest";
import { isLoopSchedulerEnabled } from "../config.js";

describe("isLoopSchedulerEnabled", () => {
  it("is off unless set to a truthy value", () => {
    expect(isLoopSchedulerEnabled(undefined)).toBe(false);
    expect(isLoopSchedulerEnabled("")).toBe(false);
    expect(isLoopSchedulerEnabled("false")).toBe(false);
    expect(isLoopSchedulerEnabled("TRUE")).toBe(true);
    expect(isLoopSchedulerEnabled("1")).toBe(true);
  });
});
