import type { Executor, ExecOptions } from "./interface.js";

/**
 * Sessions deleted while a run was still in flight. The delete releases the
 * run's parked decisions, which resumes it in a microtask, so the run outlives
 * the session row for as long as it takes to narrate its way out.
 */
const deletedSessions = new Set<string>();

export function markSessionDeleted(sessionId: string): void {
  deletedSessions.add(sessionId);
}

/** Drop the mark once the run has settled and the executor is torn down. */
export function clearSessionDeleted(sessionId: string): void {
  deletedSessions.delete(sessionId);
}

export function isSessionDeleted(sessionId: string): boolean {
  return deletedSessions.has(sessionId);
}

export const DELETED_SESSION_SANDBOX_ERROR =
  "This chat session has been deleted; its sandbox is no longer available.";

/**
 * Wrap an executor so a deleted session cannot bring a sandbox back.
 *
 * `init` is the only call that creates a container, and it is called lazily by
 * every sandbox tool. A run resumed by the delete's decision release would
 * otherwise re-init one that the service no longer tracks — leaked for the
 * life of the process. Every other call fails on its own against a sandbox
 * that is gone, so only `init` is fenced.
 */
export function fenceExecutorToSession(executor: Executor, sessionId: string): Executor {
  return {
    init: async () => {
      if (isSessionDeleted(sessionId)) throw new Error(DELETED_SESSION_SANDBOX_ERROR);
      return executor.init();
    },
    exec: (command: string, options?: ExecOptions) => executor.exec(command, options),
    getWorkspacePath: () => executor.getWorkspacePath(),
    writeFile: (path: string, content: string) => executor.writeFile(path, content),
    readFile: (path: string) => executor.readFile(path),
    isReady: () => executor.isReady(),
    destroy: () => executor.destroy(),
    cloneRepo: (url, path, options) => executor.cloneRepo(url, path, options),
    ...(executor.hasNativeGit ? { hasNativeGit: () => executor.hasNativeGit!() } : {}),
  };
}
