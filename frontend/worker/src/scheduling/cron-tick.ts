/**
 * A node-cron tick that runs one at a time and can be drained on shutdown.
 * The alert scheduler and the Loop tick both start from here.
 */
import cron from "node-cron";

export interface CronTickOptions {
  /** Log prefix: "Alerts" logs as "[Alerts] ...". */
  readonly label: string;
  readonly expression: string;
  readonly tick: (now: Date) => Promise<void>;
  /**
   * Re-read before every tick, so a switch flipped while the process runs takes
   * effect without a restart. A tick it turns down is skipped.
   */
  readonly isEnabled?: () => boolean;
}

export interface CronTickHandle {
  readonly label: string;
  readonly stop: () => void;
  /** Resolves true once no tick is in flight, false if the bound expired first. */
  readonly waitForIdle: (timeoutMs: number) => Promise<boolean>;
}

export function startCronTick({
  label,
  expression,
  tick,
  isEnabled,
}: CronTickOptions): CronTickHandle {
  const log = (message: string) => console.log(`[${label}] ${message}`);
  let isTicking = false;
  let isStopped = false;
  let wasEnabled = true;
  let inFlightTick = Promise.resolve();

  const task = cron.schedule(expression, async () => {
    // node-cron's stop() only clears the timer; a callback already dispatched still runs.
    if (isStopped) return;

    if (isEnabled) {
      const enabled = isEnabled();
      if (enabled !== wasEnabled) {
        log(enabled ? "scheduler switched back on" : "scheduler switched off, ticks are paused");
        wasEnabled = enabled;
      }
      if (!enabled) return;
    }

    if (isTicking) {
      log("previous tick still running, skipping this one");
      return;
    }
    isTicking = true;
    inFlightTick = (async () => {
      try {
        await tick(new Date());
      } catch (error) {
        console.error(`[${label}] tick failed`, error);
      } finally {
        isTicking = false;
      }
    })();
    await inFlightTick;
  });

  log(`scheduler started (${expression})`);
  return {
    label,
    stop: () => {
      isStopped = true;
      task.stop();
    },
    waitForIdle: async (timeoutMs: number): Promise<boolean> => {
      if (!isTicking) return true;
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          inFlightTick.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Stop every tick and wait for the in-flight ones together, each up to the
 * bound, so shutdown waits at most `timeoutMs` however many ticks there are.
 */
export async function drainCronTicks(
  handles: readonly CronTickHandle[],
  timeoutMs: number,
): Promise<void> {
  for (const handle of handles) handle.stop();
  await Promise.all(
    handles.map(async (handle) => {
      if (!(await handle.waitForIdle(timeoutMs))) {
        console.log(
          `[${handle.label}] tick still running after ${timeoutMs}ms, continuing shutdown`,
        );
      }
    }),
  );
}
