import { NextResponse } from "next/server";

// Streaming responses outlive the route handler. Keep revocation checks and
// audit finalization alive for exactly as long as their response body.
export const STREAM_CHECK_MS = 15_000;
export const STREAM_AUTH_TIMEOUT_MS = 5_000;
type Outcome = "success" | "error" | "unknown";

export function guardSupportStream(
  response: Response,
  signal: AbortSignal,
  authorized: () => Promise<boolean>,
  finalize: (outcome: Outcome) => Promise<void> = async () => {},
): NextResponse {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let overflow = false;
  let doneEvent = false;
  let errorEvent = false;
  let closed = false;
  let checking = false;
  let timer: ReturnType<typeof setInterval>;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  // Only retain bounded protocol lines, never response payloads in audit rows.
  function observe(chunk: Uint8Array) {
    const parts = decoder.decode(chunk, { stream: true }).split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (!overflow) pending += parts[i];
      if (pending.length > 65_536) {
        pending = "";
        overflow = true;
      }
      if (i === parts.length - 1) break;
      if (!overflow) {
        const line = pending.trim();
        if (line === "event: done") doneEvent = true;
        if (line === "event: error") errorEvent = true;
        if (line.startsWith("data:")) {
          try {
            const event = JSON.parse(line.slice(5));
            if (
              event.type === "error" ||
              (event.type === "message_end" &&
                ["error", "aborted"].includes(event.message?.stopReason))
            )
              errorEvent = true;
          } catch {
            /* Other SSE protocols need no interpretation. */
          }
        }
      }
      pending = "";
      overflow = false;
    }
  }
  async function finish(outcome: Outcome) {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    signal.removeEventListener("abort", abort);
    try {
      await finalize(outcome);
    } catch (error) {
      console.error("Support stream finalization failed", error);
    }
  }
  async function stillAuthorized() {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        authorized(),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), STREAM_AUTH_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  function abort() {
    if (closed) return;
    void finish("unknown");
    controller.error(new Error("Support stream ended"));
    void reader.cancel().catch(() => {});
  }
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      timer = setInterval(async () => {
        if (closed || checking) return;
        checking = true;
        try {
          if (!(await stillAuthorized())) abort();
        } catch {
          abort();
        } finally {
          // Validation outages fail closed, too.
          checking = false;
        }
      }, STREAM_CHECK_MS);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(c) {
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) {
          await finish(errorEvent ? "error" : doneEvent ? "success" : "unknown");
          c.close();
        } else {
          observe(next.value);
          c.enqueue(next.value);
        }
      } catch (error) {
        if (!closed) {
          await finish("unknown");
          c.error(error);
        }
      }
    },
    async cancel() {
      await finish("unknown");
      await reader.cancel().catch(() => {});
    },
  });
  return new NextResponse(body, response);
}
