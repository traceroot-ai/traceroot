import { describe, it, expect, vi } from "vitest";

const { QueueMock } = vi.hoisted(() => ({
  QueueMock: vi.fn(function (this: Record<string, unknown>, name: string, opts: unknown) {
    this.name = name;
    this.opts = opts;
  }),
}));
vi.mock("bullmq", () => ({ Queue: QueueMock }));

import {
  LOOP_RUN_QUEUE,
  createLoopRunQueue,
  enqueueLoopRun,
  loopRunJobId,
} from "../loop-run-queue.js";

describe("loop run queue", () => {
  it("names each run's job after the run, so a run is queued once", () => {
    expect(loopRunJobId("r1")).toBe("loop-run-r1");
    expect(loopRunJobId("r1")).toBe(loopRunJobId("r1"));
    expect(loopRunJobId("r2")).not.toBe(loopRunJobId("r1"));
  });

  it("enqueues one attempt that is removed once it finishes", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    await enqueueLoopRun({ add }, "r1");
    expect(add).toHaveBeenCalledWith(
      "loop-run",
      { runId: "r1" },
      { jobId: "loop-run-r1", attempts: 1, removeOnComplete: true, removeOnFail: true },
    );
  });

  it("passes a failed enqueue to the caller", async () => {
    const add = vi.fn().mockRejectedValue(new Error("redis down"));
    await expect(enqueueLoopRun({ add }, "r1")).rejects.toThrow("redis down");
  });

  it("opens the queue on the given connection", () => {
    const connection = {} as never;
    createLoopRunQueue(connection);
    expect(QueueMock).toHaveBeenCalledWith(LOOP_RUN_QUEUE, { connection });
  });
});
