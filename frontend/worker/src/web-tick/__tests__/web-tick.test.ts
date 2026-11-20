import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bull = vi.hoisted(() => ({
  upsertJobScheduler: vi.fn(),
  close: vi.fn(async () => undefined),
  workers: [] as Array<{
    name: string;
    processor: () => Promise<unknown>;
    opts: Record<string, unknown>;
  }>,
}));
vi.mock("bullmq", () => ({
  Queue: class {
    upsertJobScheduler = bull.upsertJobScheduler;
  },
  Worker: class {
    constructor(name: string, processor: () => Promise<unknown>, opts: Record<string, unknown>) {
      bull.workers.push({ name, processor, opts });
    }
    on() {
      return this;
    }
    close = bull.close;
  },
}));
vi.mock("../../queues/detector-run-queue.js", () => ({ createRedisConnection: () => ({}) }));

import { runWebTick, startWebTickWorker, WEB_TICK_TIMEOUT_MS } from "../web-tick.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("INTERNAL_API_SECRET", "tick-secret");
  vi.stubEnv("TRACEROOT_UI_URL", "http://web.test");
  bull.upsertJobScheduler.mockReset().mockResolvedValue(undefined);
  bull.workers.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runWebTick", () => {
  it("posts to the web app's tick route with the internal secret and a timeout", async () => {
    await runWebTick();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://web.test/api/internal/scheduled-tick");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "X-Internal-Secret": "tick-secret",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws when the web app answers with an error, so BullMQ retries the tick", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 503 }));

    await expect(runWebTick()).rejects.toThrow("web tick answered 503");
  });

  it("throws when the web app cannot be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(runWebTick()).rejects.toThrow("fetch failed");
  });

  it("is skipped where the internal secret is not set", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "");

    await runWebTick();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("startWebTickWorker", () => {
  it("upserts one scheduler with a fixed id, every 15 minutes, retried with backoff", () => {
    startWebTickWorker();

    expect(bull.upsertJobScheduler).toHaveBeenCalledWith(
      "web-tick",
      { every: 15 * 60 * 1000 },
      {
        name: "tick",
        data: {},
        opts: {
          attempts: 3,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      },
    );
  });

  it("runs one tick at a time, holding the job longer than the request may take", () => {
    startWebTickWorker();

    const [worker] = bull.workers;
    expect(worker.name).toBe("web-tick");
    expect(worker.opts.concurrency).toBe(1);
    expect(worker.opts.lockDuration as number).toBeGreaterThan(WEB_TICK_TIMEOUT_MS);
  });

  it("processes each job by running the tick", async () => {
    startWebTickWorker();

    await bull.workers[0].processor();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("closeWebTickWorker", () => {
  it("cancels a tick in progress instead of waiting it out, then closes the worker", async () => {
    // A fresh module: shutting down is for good, so no other test may share it.
    vi.resetModules();
    const {
      closeWebTickWorker,
      runWebTick: tick,
      startWebTickWorker: start,
    } = await import("../web-tick.js");
    // A web app that has not answered yet; only cancelling the request ends it.
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener("abort", () => reject(init.signal.reason)),
        ),
    );
    const running = tick();
    const worker = start() as unknown as Parameters<typeof closeWebTickWorker>[0];

    await closeWebTickWorker(worker);

    await expect(running).rejects.toThrow("the detector service is shutting down");
    expect(bull.close).toHaveBeenCalledOnce();
  });
});
