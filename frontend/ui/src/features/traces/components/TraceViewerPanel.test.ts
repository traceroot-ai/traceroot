import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const sourcePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "TraceViewerPanel.tsx",
);
const source = readFileSync(sourcePath, "utf8");

describe("TraceViewerPanel trace loading", () => {
  it("uses the auth-aware useTrace hook instead of fetching trace details directly", () => {
    expect(source).toContain('import { useTrace } from "../hooks";');
    expect(source).toContain("useTrace(projectId, traceId)");
    expect(source).not.toContain('import { getTrace } from "@/lib/api"');
    expect(source).not.toContain("queryFn: () => getTrace(projectId, traceId");
  });

  it("keeps loading visible while the auth-gated trace query is pending", () => {
    expect(source).toContain("isPending");
    expect(source).toContain("Loading trace...");
    expect(source).not.toContain("isLoading ?");
  });
});
