import { describe, it, expect } from "vitest";
import {
  DETECTOR_RUN_QUEUE,
  DETECTOR_RCA_QUEUE,
  type DetectorRunJob,
  type DetectorRcaJob,
} from "../detector-run-queue";

describe("Detector queue constants", () => {
  it("DETECTOR_RUN_QUEUE has correct value", () => {
    expect(DETECTOR_RUN_QUEUE).toBe("detector-run");
  });

  it("DETECTOR_RCA_QUEUE has correct value", () => {
    expect(DETECTOR_RCA_QUEUE).toBe("detector-rca");
  });
});

describe("DetectorRunJob type shape", () => {
  it("accepts valid job shape", () => {
    const job: DetectorRunJob = {
      traceId: "trace-123",
      detectorId: "det-456",
      projectId: "proj-789",
    };
    expect(job.traceId).toBe("trace-123");
    expect(job.detectorId).toBe("det-456");
    expect(job.projectId).toBe("proj-789");
  });
});

describe("DetectorRcaJob type shape", () => {
  it("accepts valid job shape", () => {
    const job: DetectorRcaJob = {
      findingId: "finding-xyz",
      projectId: "proj-789",
      traceId: "trace-abc",
      workspaceId: "ws-111",
      projectName: "My Project",
      findings: [
        {
          detectorId: "det-456",
          detectorName: "error detector",
          summary: "Something bad happened",
        },
      ],
      emailAddresses: ["user@example.com"],
    };
    expect(job.traceId).toBe("trace-abc");
    expect(job.findings[0].detectorId).toBe("det-456");
    expect(job.findings[0].summary).toBe("Something bad happened");
  });
});
