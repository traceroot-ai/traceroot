import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signalsBackend } from "../backend-client.js";

const mockFetch = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  vi.stubEnv("BACKEND_INTERNAL_URL", "http://backend:8000");
  vi.stubEnv("INTERNAL_API_SECRET", "sec");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => "",
});

describe("signalsBackend", () => {
  it("reads a partition's waiting hits with the internal secret", async () => {
    mockFetch.mockResolvedValueOnce(ok({ data: [{ run_id: "r1" }] }));
    await expect(signalsBackend.waitingHits("p", "d", 1234.7, 200)).resolves.toEqual([
      { run_id: "r1" },
    ]);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      "http://backend:8000/api/v1/internal/signals/waiting-hits?project_id=p&detector_id=d&since_ms=1234&limit=200",
    );
    expect(init).toMatchObject({ method: "GET", headers: { "X-Internal-Secret": "sec" } });
  });

  it("posts assignment rows and skips an empty batch", async () => {
    mockFetch.mockResolvedValueOnce(ok({ ok: true }));
    const row = {
      project_id: "p",
      detector_id: "d",
      run_id: "r",
      trace_id: "t",
      signal_id: "s",
      embedding: [0.1],
      score: null,
      criteria_version: 1,
      assigned_at_ms: 5,
    };
    await signalsBackend.writeAssignments([row]);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://backend:8000/api/v1/internal/signals/assignments");
    expect(JSON.parse(init.body)).toEqual({ rows: [row] });
    await signalsBackend.writeAssignments([]);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("reports the status and body of a failed call, and a timeout", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "clickhouse unavailable",
    });
    await expect(signalsBackend.waitingHits("p", "d", 1, 2)).rejects.toThrow(
      "returned 503: clickhouse unavailable",
    );
    vi.useFakeTimers();
    mockFetch.mockImplementationOnce(
      (_u: string, init: { signal: AbortSignal }) =>
        new Promise((_, reject) =>
          init.signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const p = signalsBackend.waitingHits("p", "d", 1, 2);
    const assertion = expect(p).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
});
