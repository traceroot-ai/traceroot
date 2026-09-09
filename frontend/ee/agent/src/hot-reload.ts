/**
 * Reload safety for the dev runner.
 *
 * `vite-node --watch` re-executes the entry module in the SAME process on
 * every source edit — it does not fork a new one. Anything the previous
 * execution left bound to the process (the HTTP listener, signal handlers)
 * therefore survives the reload. A listener that is never closed makes the
 * next `serve()` throw `EADDRINUSE`, the reload dies, and the process keeps
 * answering requests from the snapshot it booted with: edits stop reaching
 * anything that talks to the service, silently.
 *
 * The previous execution's state has to outlive the module instance, so it
 * hangs off a `globalThis` slot rather than a module-level binding.
 */

/** The slice of a node/hono server this module needs, so tests can pass a fake. */
export interface ReloadableListener {
  close(callback?: (error?: Error) => void): void;
  /** http.Server only; keep-alive sockets otherwise hold `close` open. */
  closeAllConnections?: () => void;
}

/** The slice of a sandbox executor this module needs to tear one down. */
export interface Destroyable {
  destroy(): Promise<void>;
}

interface HotState {
  listener?: ReloadableListener;
  signalHandlers?: Array<[NodeJS.Signals, () => void]>;
  executors?: Map<string, Destroyable>;
}

const SLOT = "__traceRootAgentHotState";

function hotState(): HotState {
  const carrier = globalThis as typeof globalThis & { [SLOT]?: HotState };
  return (carrier[SLOT] ??= {});
}

/** Hand the live listener to the next execution of this module. */
export function rememberListener(listener: ReloadableListener): void {
  hotState().listener = listener;
}

/**
 * Hand the live executors to the next execution, so a reload tears down the
 * sandbox containers the previous module instance would otherwise orphan.
 */
export function rememberExecutors(executors: Map<string, Destroyable>): void {
  hotState().executors = executors;
}

/**
 * Tear down what the previous execution left running: its sandbox executors,
 * then the listener holding the port, if any.
 *
 * Resolves once the old listener is down. A close that fails is logged loudly
 * rather than swallowed: the alternative is a stale server still bound to the
 * port while the new code believes it is serving.
 */
export async function closePreviousListener(): Promise<void> {
  const executors = hotState().executors;
  hotState().executors = undefined;
  for (const [id, executor] of executors ?? []) {
    await executor.destroy().catch((error: unknown) => {
      console.error(`[Agent] Failed to destroy the previous execution's executor ${id}:`, error);
    });
  }
  executors?.clear();

  const previous = hotState().listener;
  if (!previous) return;
  hotState().listener = undefined;

  await new Promise<void>((resolve) => {
    // Without this, an idle keep-alive connection (a browser tab, an SSE
    // reader) holds `close` open and the reload stalls instead of rebinding.
    previous.closeAllConnections?.();
    previous.close((error) => {
      if (error) {
        console.error(
          "[Agent] Failed to close the previous listener — this process may still be serving stale code on the old port:",
          error,
        );
      }
      resolve();
    });
  });
}

/**
 * Register process signal handlers, replacing the ones a previous execution
 * left behind. Re-running the module would otherwise stack a new handler per
 * reload, so one Ctrl-C would fan out to every generation's shutdown.
 */
export function registerSignalHandlers(
  signals: readonly NodeJS.Signals[],
  onSignal: (signal: NodeJS.Signals) => void,
): void {
  const state = hotState();
  for (const [signal, handler] of state.signalHandlers ?? []) {
    process.off(signal, handler);
  }
  const handlers = signals.map((signal): [NodeJS.Signals, () => void] => [
    signal,
    () => onSignal(signal),
  ]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  state.signalHandlers = handlers;
}
