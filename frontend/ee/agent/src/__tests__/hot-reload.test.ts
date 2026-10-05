import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  rememberExecutors,
  closePreviousListener,
  registerSignalHandlers,
  rememberListener,
  type ReloadableListener,
} from "../hot-reload.js";

/** The slot the module hands across a `vite-node --watch` re-execution. */
const SLOT = "__traceRootAgentHotState";

function resetHotState(): void {
  delete (globalThis as Record<string, unknown>)[SLOT];
}

function fakeListener(closeError?: Error): ReloadableListener & {
  closed: () => number;
  connectionsClosed: () => number;
} {
  let closed = 0;
  let connectionsClosed = 0;
  return {
    close(callback?: (error?: Error) => void) {
      closed += 1;
      callback?.(closeError);
    },
    closeAllConnections() {
      connectionsClosed += 1;
    },
    closed: () => closed,
    connectionsClosed: () => connectionsClosed,
  };
}

beforeEach(resetHotState);

afterEach(() => {
  // Handlers a test registered are on the real process; drop them.
  registerSignalHandlers([], () => {});
  resetHotState();
  vi.restoreAllMocks();
});

describe("closePreviousListener", () => {
  it("does nothing when no previous execution left a listener", async () => {
    await expect(closePreviousListener()).resolves.toBeUndefined();
  });

  it("closes the listener a previous execution remembered, dropping its connections", async () => {
    const listener = fakeListener();
    rememberListener(listener);

    await closePreviousListener();

    expect(listener.closed()).toBe(1);
    expect(listener.connectionsClosed()).toBe(1);
  });

  it("closes each listener once, so a second reload does not re-close a dead one", async () => {
    const listener = fakeListener();
    rememberListener(listener);

    await closePreviousListener();
    await closePreviousListener();

    expect(listener.closed()).toBe(1);
  });

  it("logs loudly when the close fails instead of leaving it silent", async () => {
    const error = new Error("EADDRINUSE");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    rememberListener(fakeListener(error));

    await closePreviousListener();

    expect(logged).toHaveBeenCalledWith(expect.stringContaining("stale code"), error);
  });

  it("tolerates a listener with no closeAllConnections (http2 servers have none)", async () => {
    let closed = 0;
    rememberListener({
      close(callback?: (error?: Error) => void) {
        closed += 1;
        callback?.();
      },
    });

    await closePreviousListener();

    expect(closed).toBe(1);
  });
});

describe("rememberExecutors", () => {
  it("destroys the previous execution's executors before the listener is closed", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const executors = new Map([["sess-1", { destroy }]]);
    rememberExecutors(executors);
    await closePreviousListener();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(executors.size).toBe(0);
    // A second reload finds nothing to destroy.
    await closePreviousListener();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe("registerSignalHandlers", () => {
  it("registers a handler per signal", () => {
    const onSignal = vi.fn();
    registerSignalHandlers(["SIGUSR2"], onSignal);

    process.emit("SIGUSR2", "SIGUSR2");

    expect(onSignal).toHaveBeenCalledWith("SIGUSR2");
  });

  it("removes the previous execution's handlers so a reload does not stack them", () => {
    const first = vi.fn();
    registerSignalHandlers(["SIGUSR2"], first);
    const second = vi.fn();
    registerSignalHandlers(["SIGUSR2"], second);

    process.emit("SIGUSR2", "SIGUSR2");

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
