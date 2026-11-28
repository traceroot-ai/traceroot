import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));

import { ApiError } from "./errors";
import { getTrace, TRACE_FETCH_TIMEOUT_MS } from "./traces";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("getTrace timeout", () => {
  it("fails a request the server never answers instead of waiting forever", async () => {
    // Stand in for AbortSignal.timeout with a signal the test fires itself.
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    // A server that accepted the request and never answers: the only way out is the signal.
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = getTrace("p-1", "t-1", "", { id: "u1" }).catch((e: unknown) => e);
    expect(timeout).toHaveBeenCalledWith(TRACE_FETCH_TIMEOUT_MS);
    expect(fetchMock.mock.calls[0][1].signal).toBe(deadline.signal);

    deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const err = await pending;
    expect((err as DOMException).name).toBe("TimeoutError");
    // No HTTP status: the viewer reads it as a failed load, not a missing trace.
    expect(err).not.toBeInstanceOf(ApiError);
  });
});
