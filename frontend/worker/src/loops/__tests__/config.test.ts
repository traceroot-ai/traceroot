import { afterEach, describe, it, expect, vi } from "vitest";
import { LOOP_LIMITS } from "@traceroot/core/loops";
import {
  DEFAULT_LOOP_RUN_CONCURRENCY,
  DEFAULT_LOOP_TICK_CRON,
  isLoopSchedulerEnabled,
  loopRunConcurrency,
  loopRunTimeoutMs,
  loopTickCron,
} from "../config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isLoopSchedulerEnabled", () => {
  it("is off unless set to a truthy value", () => {
    expect(isLoopSchedulerEnabled(undefined)).toBe(false);
    expect(isLoopSchedulerEnabled("")).toBe(false);
    expect(isLoopSchedulerEnabled("false")).toBe(false);
    expect(isLoopSchedulerEnabled("TRUE")).toBe(true);
    expect(isLoopSchedulerEnabled("1")).toBe(true);
  });
});

describe("loopTickCron", () => {
  it("takes LOOP_TICK_CRON, or the default when it is unset or blank", () => {
    vi.stubEnv("LOOP_TICK_CRON", undefined);
    expect(loopTickCron()).toBe(DEFAULT_LOOP_TICK_CRON);
    vi.stubEnv("LOOP_TICK_CRON", "   ");
    expect(loopTickCron()).toBe(DEFAULT_LOOP_TICK_CRON);
    vi.stubEnv("LOOP_TICK_CRON", " */2 * * * * ");
    expect(loopTickCron()).toBe("*/2 * * * *");
  });

  it("warns and takes the default when LOOP_TICK_CRON is not a valid expression", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of ["every 5 minutes", "*/5 * * *", "61 * * * *"]) {
      vi.stubEnv("LOOP_TICK_CRON", bad);
      expect(loopTickCron()).toBe(DEFAULT_LOOP_TICK_CRON);
    }
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe("loopRunTimeoutMs and loopRunConcurrency", () => {
  it("take a positive whole number from the environment", () => {
    vi.stubEnv("LOOP_RUN_TIMEOUT_MS", " 90000 ");
    vi.stubEnv("LOOP_RUN_CONCURRENCY", "4");
    expect(loopRunTimeoutMs()).toBe(90_000);
    expect(loopRunConcurrency()).toBe(4);
  });

  it("fall back to their defaults on a missing, zero, negative, fractional or non-number value", () => {
    const fallbackTimeout = LOOP_LIMITS.runTimeoutMinutes * 60_000;
    vi.stubEnv("LOOP_RUN_TIMEOUT_MS", undefined);
    vi.stubEnv("LOOP_RUN_CONCURRENCY", undefined);
    expect(loopRunTimeoutMs()).toBe(fallbackTimeout);
    expect(loopRunConcurrency()).toBe(DEFAULT_LOOP_RUN_CONCURRENCY);
    for (const bad of ["", "0", "-3", "1.5", "soon"]) {
      vi.stubEnv("LOOP_RUN_TIMEOUT_MS", bad);
      vi.stubEnv("LOOP_RUN_CONCURRENCY", bad);
      expect(loopRunTimeoutMs()).toBe(fallbackTimeout);
      expect(loopRunConcurrency()).toBe(DEFAULT_LOOP_RUN_CONCURRENCY);
    }
  });
});
