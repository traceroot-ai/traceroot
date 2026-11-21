import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type CronHandler = () => Promise<void> | void;
const cronSchedule = vi.fn((expression: string, handler: CronHandler) => ({
  expression,
  handler,
  stop: vi.fn(),
}));
vi.mock("node-cron", () => ({
  default: {
    schedule: (expression: string, handler: CronHandler) => cronSchedule(expression, handler),
  },
}));

const { startCronTick, drainCronTicks } = await import("../cron-tick.js");

const handlerAt = (index: number): CronHandler => cronSchedule.mock.calls[index][1];

function blockedTick(): { tick: () => Promise<void>; release: () => void } {
  let release = () => {};
  const tick = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  return { tick, release: () => release() };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  cronSchedule.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startCronTick", () => {
  it("schedules the expression and ticks with no switch to read", async () => {
    const tick = vi.fn(async (_now: Date) => {});
    startCronTick({ label: "Loops", expression: "*/5 * * * *", tick });
    expect(cronSchedule.mock.calls[0][0]).toBe("*/5 * * * *");

    await handlerAt(0)();
    await handlerAt(0)();
    expect(tick).toHaveBeenCalledTimes(2);
    expect(tick.mock.calls[0][0]).toBeInstanceOf(Date);
  });

  it("skips a tick while the previous one is still running", async () => {
    const { tick, release } = blockedTick();
    startCronTick({ label: "Loops", expression: "* * * * *", tick });

    const first = handlerAt(0)();
    await handlerAt(0)();
    expect(tick).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it("logs a throwing tick under its label and clears the latch", async () => {
    const tick = vi.fn(async () => {
      throw new Error("boom");
    });
    startCronTick({ label: "Loops", expression: "* * * * *", tick });

    await handlerAt(0)();
    await handlerAt(0)();
    expect(tick).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith("[Loops] tick failed", expect.any(Error));
  });
});

describe("drainCronTicks", () => {
  it("stops every tick and waits for the in-flight ones together, within one bound", async () => {
    vi.useFakeTimers();
    try {
      const stuck = startCronTick({
        label: "Alerts",
        expression: "* * * * *",
        tick: () => new Promise(() => {}),
      });
      const idle = startCronTick({ label: "Loops", expression: "* * * * *", tick: async () => {} });
      void handlerAt(0)();

      let isDone = false;
      const drained = drainCronTicks([stuck, idle], 5_000).then(() => {
        isDone = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(isDone).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await drained;

      expect(cronSchedule.mock.results[0].value.stop).toHaveBeenCalledTimes(1);
      expect(cronSchedule.mock.results[1].value.stop).toHaveBeenCalledTimes(1);
      expect(console.log).toHaveBeenCalledWith(
        "[Alerts] tick still running after 5000ms, continuing shutdown",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns at once when nothing is ticking", async () => {
    const handle = startCronTick({ label: "Loops", expression: "* * * * *", tick: async () => {} });
    await drainCronTicks([handle], 60_000);
    expect(cronSchedule.mock.results[0].value.stop).toHaveBeenCalledTimes(1);
  });
});
