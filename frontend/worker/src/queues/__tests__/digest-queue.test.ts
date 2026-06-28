import { describe, it, expect } from "vitest";
import { DETECTOR_DIGEST_QUEUE, windowStartFor, type DigestFlushJob } from "../digest-queue.js";

describe("digest queue", () => {
  it("queue name constant", () => {
    expect(DETECTOR_DIGEST_QUEUE).toBe("detector-digest");
  });

  it("windowStartFor floors a finding timestamp to the window boundary", () => {
    const W = 1_800_000; // 30m
    expect(windowStartFor(0, W)).toBe(0);
    expect(windowStartFor(W - 1, W)).toBe(0);
    expect(windowStartFor(W, W)).toBe(W);
    expect(windowStartFor(W + 5, W)).toBe(W);
  });
});

describe("DigestFlushJob type shape", () => {
  it("accepts valid job shape", () => {
    const job: DigestFlushJob = {
      projectId: "proj-789",
      windowStart: 1_800_000,
      windowMs: 1_800_000,
    };
    expect(job.projectId).toBe("proj-789");
    expect(job.windowStart).toBe(1_800_000);
    expect(job.windowMs).toBe(1_800_000);
  });
});
