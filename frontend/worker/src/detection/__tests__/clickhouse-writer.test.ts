import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { writeDetectorRun, writeDetectorFinding } from "../clickhouse-writer.js";

describe("writeDetectorRun", () => {
  beforeEach(() => vi.clearAllMocks());

  it("posts to /api/v1/internal/detector-runs", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await writeDetectorRun({
      runId: "run-1",
      detectorId: "det-1",
      projectId: "proj-1",
      traceId: "trace-1",
      findingId: null,
      status: "completed",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/internal/detector-runs"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("error"),
    });

    await expect(
      writeDetectorRun({
        runId: "r",
        detectorId: "d",
        projectId: "p",
        traceId: "t",
        findingId: null,
        status: "failed",
      }),
    ).rejects.toThrow("Backend API error 500");
  });

  it("includes X-Internal-Secret header", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await writeDetectorRun({
      runId: "r",
      detectorId: "d",
      projectId: "p",
      traceId: "t",
      findingId: null,
      status: "completed",
    });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers).toHaveProperty("X-Internal-Secret");
  });
});

describe("writeDetectorFinding", () => {
  beforeEach(() => vi.clearAllMocks());

  it("posts to /api/v1/internal/detector-findings", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await writeDetectorFinding({
      findingId: "finding-1",
      projectId: "proj-1",
      traceId: "trace-1",
      summary: "Something bad",
      payload: "{}",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/internal/detector-findings"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});
