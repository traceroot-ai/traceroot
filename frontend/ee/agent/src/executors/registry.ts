import type { Executor } from "./interface.js";

/** Sandboxes idle for longer than this are torn down. 0 disables the sweep. */
const DEFAULT_IDLE_TTL_MINUTES = 30;

export function idleTtlMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SANDBOX_IDLE_TTL_MINUTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_IDLE_TTL_MINUTES * 60_000;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_IDLE_TTL_MINUTES * 60_000;
  return minutes * 60_000;
}

interface Entry {
  executor: Executor;
  lastUsedAt: number;
}

/**
 * Owns the sandbox executors of live sessions and reclaims them when they go
 * idle.
 *
 * Sessions were previously created and never deleted — the only two callers of
 * `destroy()` were an HTTP route nothing invokes and the shutdown handler — so a
 * long-running agent held every container it had ever created. An idle TTL gives
 * a container a bounded lifetime even when nothing ever tells us its session is
 * finished, mirroring Daytona's `autoStopInterval`.
 */
export class SandboxRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly create: (sessionId: string) => Executor;
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(options: {
    create: (sessionId: string) => Executor;
    idleTtlMs: number;
    now?: () => number;
  }) {
    this.create = options.create;
    this.idleTtlMs = options.idleTtlMs;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  /** The session's executor, created on first use. Marks the session as active. */
  acquire(sessionId: string): Executor {
    const existing = this.entries.get(sessionId);
    if (existing) {
      existing.lastUsedAt = this.now();
      return existing.executor;
    }
    const executor = this.create(sessionId);
    this.entries.set(sessionId, { executor, lastUsedAt: this.now() });
    return executor;
  }

  /** Tear down one session's sandbox. Safe to call for an unknown session. */
  async release(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    await entry.executor.destroy();
  }

  /** Tear down every sandbox idle for longer than the TTL. Returns their ids. */
  async sweepIdle(): Promise<string[]> {
    if (this.idleTtlMs <= 0) return [];
    const cutoff = this.now() - this.idleTtlMs;
    const stale = [...this.entries.entries()]
      .filter(([, entry]) => entry.lastUsedAt <= cutoff)
      .map(([sessionId]) => sessionId);

    // Settled, not all: one container that refuses to die must not strand the
    // rest for another TTL.
    await Promise.allSettled(stale.map((sessionId) => this.release(sessionId)));
    return stale;
  }

  /**
   * Run the idle sweep on an interval. The timer is unref'd so it never holds
   * the process open on its own.
   */
  startSweeping(intervalMs = 60_000): void {
    if (this.sweepTimer || this.idleTtlMs <= 0) return;
    this.sweepTimer = setInterval(() => {
      void this.sweepIdle().then((swept) => {
        if (swept.length > 0) {
          console.log(`[Agent] Reclaimed ${swept.length} idle sandbox(es)`);
        }
      });
    }, intervalMs);
    this.sweepTimer.unref?.();
  }

  stopSweeping(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * Tear down every sandbox, concurrently. Sequential teardown was itself a leak
   * source: compose's default 10s stop grace period can expire partway through N
   * `docker rm -f` calls, after which SIGKILL leaves the remainder running.
   */
  async destroyAll(): Promise<void> {
    this.stopSweeping();
    const sessionIds = [...this.entries.keys()];
    await Promise.allSettled(sessionIds.map((sessionId) => this.release(sessionId)));
  }
}
