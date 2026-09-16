import { afterEach, expect, it, vi } from "vitest";
import { guardSupportStream, STREAM_CHECK_MS } from "./stream";
afterEach(() => vi.useRealTimers());
it.each([
  ["event: done\ndata: {}\n\n", "success"],
  ["event: error\ndata: {}\n\nevent: done\ndata: {}\n\n", "error"],
  [
    'data: {"type":"message_end","message":{"stopReason":"error"}}\n\nevent: done\ndata: {}\n\n',
    "error",
  ],
  ["data: {}\n\n", "unknown"],
])("finalizes only on completion (%s)", async (payload, outcome) => {
  const finalize = vi.fn(async () => {});
  const response = guardSupportStream(
    new Response(payload),
    new AbortController().signal,
    async () => true,
    finalize,
  );
  expect(finalize).not.toHaveBeenCalled();
  expect(await response.text()).toBe(payload);
  expect(finalize).toHaveBeenCalledExactlyOnceWith(outcome);
});
it.each(["revoked", "outage"])("closes idle streams on %s", async (mode) => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const finalize = vi.fn(async () => {});
  const allowed = vi.fn(async () => {
    if (mode === "outage") throw Error("offline");
    return false;
  });
  const response = guardSupportStream(
    new Response(new ReadableStream({ cancel })),
    new AbortController().signal,
    allowed,
    finalize,
  );
  const read = response.text();
  const rejection = expect(read).rejects.toThrow("Support stream ended");
  await vi.advanceTimersByTimeAsync(STREAM_CHECK_MS);
  await rejection;
  expect(cancel).toHaveBeenCalledOnce();
  expect(finalize).toHaveBeenCalledExactlyOnceWith("unknown");
  expect(vi.getTimerCount()).toBe(0);
});
it("finalizes disconnects and cancels upstream once", async () => {
  const cancel = vi.fn();
  const finalize = vi.fn(async () => {});
  const response = guardSupportStream(
    new Response(new ReadableStream({ cancel })),
    new AbortController().signal,
    async () => true,
    finalize,
  );
  await response.body!.cancel();
  expect(cancel).toHaveBeenCalledOnce();
  expect(finalize).toHaveBeenCalledExactlyOnceWith("unknown");
});
it("recognizes terminal events split across chunks", async () => {
  const finalize = vi.fn(async () => {});
  const response = guardSupportStream(
    new Response(
      new ReadableStream({
        start(c) {
          for (const text of ["event: do", "ne\ndata: {}\n\n"])
            c.enqueue(new TextEncoder().encode(text));
          c.close();
        },
      }),
    ),
    new AbortController().signal,
    async () => true,
    finalize,
  );
  await response.text();
  expect(finalize).toHaveBeenCalledExactlyOnceWith("success");
});
