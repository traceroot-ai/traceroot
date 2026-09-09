import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  projectCount,
  disconnect,
  syncStandardPrices,
  runBillingJob,
  runStartupBillingPass,
  closeClickHouseClient,
  cronSchedule,
} = vi.hoisted(() => ({
  projectCount: vi.fn(),
  disconnect: vi.fn(),
  syncStandardPrices: vi.fn(),
  runBillingJob: vi.fn(),
  runStartupBillingPass: vi.fn(),
  closeClickHouseClient: vi.fn(),
  cronSchedule: vi.fn(),
}));

vi.mock("@traceroot/core", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    prisma: {
      project: { count: projectCount },
      $disconnect: disconnect,
    },
    syncStandardPrices,
  };
});

vi.mock("./ee/billing/index.js", () => ({
  runBillingJob,
  runStartupBillingPass,
  closeClickHouseClient,
}));

vi.mock("node-cron", () => ({
  default: { schedule: cronSchedule },
}));

describe("billing worker entrypoint", () => {
  let sigtermHandler: (() => void | Promise<void>) | undefined;

  beforeEach(() => {
    vi.resetModules();
    projectCount.mockReset().mockResolvedValue(3);
    disconnect.mockReset().mockResolvedValue(undefined);
    syncStandardPrices.mockReset().mockResolvedValue(undefined);
    runBillingJob.mockReset().mockResolvedValue(undefined);
    runStartupBillingPass.mockReset().mockResolvedValue(undefined);
    closeClickHouseClient.mockReset().mockResolvedValue(undefined);
    cronSchedule.mockReset();
    sigtermHandler = undefined;

    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => void) => {
      if (event === "SIGTERM") sigtermHandler = handler;
      return process;
    }) as typeof process.on);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connects, syncs prices, schedules the hourly cron, and fires the startup pass", async () => {
    await import("./index.js");

    await vi.waitFor(() => expect(cronSchedule).toHaveBeenCalled());

    expect(projectCount).toHaveBeenCalled();
    expect(syncStandardPrices).toHaveBeenCalled();
    expect(cronSchedule).toHaveBeenCalledWith("5 * * * *", expect.any(Function));
    await vi.waitFor(() => expect(runStartupBillingPass).toHaveBeenCalled());
  });

  it("runs the scheduled billing job when the cron callback fires", async () => {
    await import("./index.js");
    await vi.waitFor(() => expect(cronSchedule).toHaveBeenCalled());
    await vi.waitFor(() => expect(runStartupBillingPass).toHaveBeenCalled());

    const [, cronCallback] = cronSchedule.mock.calls[0];
    await cronCallback();

    expect(runBillingJob).toHaveBeenCalled();
  });

  it("logs and swallows a rejected scheduled billing job instead of throwing", async () => {
    runBillingJob.mockRejectedValue(new Error("clickhouse down"));

    await import("./index.js");
    await vi.waitFor(() => expect(cronSchedule).toHaveBeenCalled());
    await vi.waitFor(() => expect(runStartupBillingPass).toHaveBeenCalled());

    const [, cronCallback] = cronSchedule.mock.calls[0];
    await expect(cronCallback()).resolves.toBeUndefined();
  });

  it("skips a concurrent cron tick while the startup pass is still in flight", async () => {
    let resolveStartup: () => void = () => {};
    runStartupBillingPass.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStartup = resolve;
        }),
    );

    await import("./index.js");
    await vi.waitFor(() => expect(cronSchedule).toHaveBeenCalled());
    await vi.waitFor(() => expect(runStartupBillingPass).toHaveBeenCalled());

    const [, cronCallback] = cronSchedule.mock.calls[0];
    await cronCallback();

    expect(runBillingJob).not.toHaveBeenCalled();

    resolveStartup();
  });

  it("shuts down cleanly on SIGTERM", async () => {
    await import("./index.js");
    await vi.waitFor(() => expect(cronSchedule).toHaveBeenCalled());

    expect(sigtermHandler).toBeDefined();
    await sigtermHandler?.();

    expect(closeClickHouseClient).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
