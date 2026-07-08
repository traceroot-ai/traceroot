// Unit test: verify Dashboard and Widget types are exported from @traceroot/core
import { describe, it, expect } from "vitest";
import { prisma } from "../lib/prisma.ts";

describe("Dashboard schema types", () => {
  it("prisma client has dashboard and widget models", () => {
    // If Prisma generated correctly, dashboard and widget will be accessible
    expect(typeof prisma.dashboard).toBe("object");
    expect(typeof prisma.dashboard.findMany).toBe("function");
    expect(typeof prisma.widget).toBe("object");
    expect(typeof prisma.widget.findMany).toBe("function");
  });
});
