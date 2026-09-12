import { beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxRegistry, idleTtlMsFromEnv } from "../registry.js";
import type { Executor } from "../interface.js";

/** A stand-in executor that only records whether it was destroyed. */
function stubExecutor(overrides: Partial<Executor> = {}): Executor & { destroyed: number } {
  const executor = {
    destroyed: 0,
    init: vi.fn(),
    exec: vi.fn(),
    getWorkspacePath: () => "/workspace",
    writeFile: vi.fn(),
    readFile: vi.fn(),
    isReady: () => true,
    cloneRepo: vi.fn(),
    destroy: vi.fn(async () => {
      executor.destroyed += 1;
    }),
    ...overrides,
  } as Executor & { destroyed: number };
  return executor;
}

let clock = 0;
const now = () => clock;

function makeRegistry(idleTtlMs = 30 * 60_000) {
  const created: Array<{ sessionId: string; executor: Executor & { destroyed: number } }> = [];
  const registry = new SandboxRegistry({
    create: (sessionId) => {
      const executor = stubExecutor();
      created.push({ sessionId, executor });
      return executor;
    },
    idleTtlMs,
    now,
  });
  return { registry, created };
}

beforeEach(() => {
  clock = 1_000_000;
});

describe("SandboxRegistry.acquire", () => {
  it("creates one executor per session and reuses it", () => {
    const { registry, created } = makeRegistry();

    const first = registry.acquire("session-a");
    const second = registry.acquire("session-a");

    expect(second).toBe(first);
    expect(created).toHaveLength(1);
    expect(created[0].sessionId).toBe("session-a");
  });
});

describe("SandboxRegistry.sweepIdle", () => {
  it("destroys sandboxes past the idle TTL and keeps the rest", async () => {
    const { registry, created } = makeRegistry(30 * 60_000);
    registry.acquire("idle");
    clock += 25 * 60_000;
    registry.acquire("active");

    clock += 20 * 60_000; // idle: 45m since last use, active: 20m
    const swept = await registry.sweepIdle();

    expect(swept).toEqual(["idle"]);
    expect(created.find((c) => c.sessionId === "idle")!.executor.destroyed).toBe(1);
    expect(created.find((c) => c.sessionId === "active")!.executor.destroyed).toBe(0);
    expect(registry.size).toBe(1);
  });

  it("treats renewed use as activity, so a busy session is never swept", async () => {
    const { registry } = makeRegistry(30 * 60_000);
    registry.acquire("busy");

    for (let i = 0; i < 5; i++) {
      clock += 29 * 60_000;
      registry.acquire("busy");
      expect(await registry.sweepIdle()).toEqual([]);
    }

    expect(registry.size).toBe(1);
  });

  it("does not sweep when the TTL is disabled", async () => {
    const { registry, created } = makeRegistry(0);
    registry.acquire("forever");
    clock += 365 * 24 * 60 * 60_000;

    expect(await registry.sweepIdle()).toEqual([]);
    expect(created[0].executor.destroyed).toBe(0);
  });
});

describe("SandboxRegistry.retain", () => {
  it("keeps a sandbox off the sweep for as long as the request holds it", async () => {
    const { registry, created } = makeRegistry(30 * 60_000);
    const release = registry.retain("long-run");

    // A tool loop far longer than the TTL: acquire() alone recorded only when the
    // turn started, so a purely time-based sweep would have killed it mid-request.
    clock += 90 * 60_000;
    expect(await registry.sweepIdle()).toEqual([]);
    expect(created[0].executor.destroyed).toBe(0);

    release();
    expect(await registry.sweepIdle()).toEqual([]); // clock restarts on release
    clock += 31 * 60_000;
    expect(await registry.sweepIdle()).toEqual(["long-run"]);
  });

  it("counts concurrent holds, so one finishing does not expose the other", async () => {
    const { registry } = makeRegistry(30 * 60_000);
    const releaseFirst = registry.retain("shared");
    const releaseSecond = registry.retain("shared");

    clock += 90 * 60_000;
    releaseFirst();
    expect(await registry.sweepIdle()).toEqual([]);

    releaseSecond();
    clock += 31 * 60_000;
    expect(await registry.sweepIdle()).toEqual(["shared"]);
  });

  it("is idempotent, so a finally that runs twice cannot free another hold", async () => {
    const { registry } = makeRegistry(30 * 60_000);
    const releaseFirst = registry.retain("shared");
    registry.retain("shared");

    releaseFirst();
    releaseFirst();

    clock += 90 * 60_000;
    expect(await registry.sweepIdle()).toEqual([]);
  });
});

describe("SandboxRegistry.destroyAll", () => {
  it("destroys every sandbox even when one teardown rejects", async () => {
    const failing = stubExecutor({
      destroy: vi.fn(async () => {
        throw new Error("docker daemon unreachable");
      }),
    });
    const survivors: Array<Executor & { destroyed: number }> = [];
    const registry = new SandboxRegistry({
      create: (sessionId) => {
        if (sessionId === "broken") return failing;
        const executor = stubExecutor();
        survivors.push(executor);
        return executor;
      },
      idleTtlMs: 30 * 60_000,
      now,
    });

    registry.acquire("broken");
    registry.acquire("ok-1");
    registry.acquire("ok-2");

    await expect(registry.destroyAll()).resolves.toBeUndefined();
    expect(survivors.every((e) => e.destroyed === 1)).toBe(true);
    expect(registry.size).toBe(0);
  });

  it("tears sandboxes down concurrently rather than one after another", async () => {
    let inFlight = 0;
    let peak = 0;
    const registry = new SandboxRegistry({
      create: () =>
        stubExecutor({
          destroy: vi.fn(async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
          }),
        }),
      idleTtlMs: 30 * 60_000,
      now,
    });

    for (let i = 0; i < 4; i++) registry.acquire(`session-${i}`);
    await registry.destroyAll();

    // Sequential teardown can outlast compose's stop grace period, after which
    // SIGKILL leaks whatever is left (#2101).
    expect(peak).toBe(4);
  });
});

describe("SandboxRegistry shutdown admission", () => {
  it("refuses new sandboxes once teardown has begun", async () => {
    const { registry, created } = makeRegistry();
    registry.acquire("before");

    await registry.destroyAll();

    // Snapshotting the map without closing admission left a window where a
    // request created a container the teardown had already walked past.
    expect(() => registry.acquire("during")).toThrow(/shutting down/);
    expect(() => registry.retain("during")).toThrow(/shutting down/);
    expect(created).toHaveLength(1);
    expect(registry.size).toBe(0);
  });

  it("drains a sandbox created while teardown was in flight", async () => {
    const created: Array<Executor & { destroyed: number }> = [];
    // Slip an acquire in while the first destroy is awaiting, the exact race the
    // snapshot-then-destroy version could not see. `racing` closes over
    // `registry` below; the closure only runs during destroyAll, long after it
    // is initialised.
    const racing = stubExecutor({
      destroy: vi.fn(async () => {
        try {
          registry.acquire("late");
        } catch {
          // Expected once admission closes — the assertion is on what got destroyed.
        }
        racing.destroyed += 1;
      }),
    });
    const registry = new SandboxRegistry({
      create: (sessionId) => {
        if (sessionId === "first") return racing;
        const executor = stubExecutor();
        created.push(executor);
        return executor;
      },
      idleTtlMs: 30 * 60_000,
      now,
    });
    registry.acquire("first");

    await registry.destroyAll();

    expect(registry.size).toBe(0);
    expect(created.every((e) => e.destroyed === 1)).toBe(true);
  });
});

describe("SandboxRegistry.startSweeping", () => {
  it("sweeps on the interval and stops when told to", async () => {
    vi.useFakeTimers();
    try {
      const { registry, created } = makeRegistry(30 * 60_000);
      registry.acquire("idle");
      clock += 31 * 60_000;

      registry.startSweeping(1_000);
      registry.startSweeping(1_000); // second call must not add a second timer
      await vi.advanceTimersByTimeAsync(1_000);

      expect(created[0].executor.destroyed).toBe(1);
      expect(registry.size).toBe(0);

      registry.stopSweeping();
      registry.stopSweeping(); // idempotent
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not arm a timer when the TTL is disabled", () => {
    vi.useFakeTimers();
    try {
      const { registry } = makeRegistry(0);
      registry.startSweeping(1_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SandboxRegistry.release", () => {
  it("destroys the session's sandbox and forgets it", async () => {
    const { registry, created } = makeRegistry();
    registry.acquire("session-a");

    await registry.release("session-a");

    expect(created[0].executor.destroyed).toBe(1);
    expect(registry.size).toBe(0);
    await expect(registry.release("session-a")).resolves.toBeUndefined();
  });
});

describe("idleTtlMsFromEnv", () => {
  it("defaults to 30 minutes when unset or unparseable", () => {
    expect(idleTtlMsFromEnv({})).toBe(30 * 60_000);
    expect(idleTtlMsFromEnv({ SANDBOX_IDLE_TTL_MINUTES: "" })).toBe(30 * 60_000);
    expect(idleTtlMsFromEnv({ SANDBOX_IDLE_TTL_MINUTES: "soon" })).toBe(30 * 60_000);
    expect(idleTtlMsFromEnv({ SANDBOX_IDLE_TTL_MINUTES: "-5" })).toBe(30 * 60_000);
  });

  it("honours an explicit value, including 0 to disable", () => {
    expect(idleTtlMsFromEnv({ SANDBOX_IDLE_TTL_MINUTES: "5" })).toBe(5 * 60_000);
    expect(idleTtlMsFromEnv({ SANDBOX_IDLE_TTL_MINUTES: "0" })).toBe(0);
  });
});
