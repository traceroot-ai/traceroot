// Unit test: verify Detector-related types are exported from @traceroot/core
import { describe, it, expect } from "vitest";
import { prisma } from "../lib/prisma.js";

describe("Detector schema types", () => {
  it("prisma client has detector model", () => {
    // If Prisma generated correctly, detector will be accessible
    expect(typeof prisma.detector).toBe("object");
    expect(typeof prisma.detector.findMany).toBe("function");
    expect(typeof prisma.detectorTrigger).toBe("object");
    expect(typeof prisma.detectorAlertConfig).toBe("object");
    expect(typeof prisma.detectorRca).toBe("object");
  });
});
