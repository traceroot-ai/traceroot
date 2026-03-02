/**
 * Matches Mom's ExecResult (sandbox.ts) — uses `code` not `exitCode`.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Matches Mom's ExecOptions — includes AbortSignal support.
 */
export interface ExecOptions {
  timeout?: number;
  signal?: AbortSignal;
}

/**
 * Extends Mom's Executor with lifecycle and file ops.
 *
 * Mom's base interface: exec() + getWorkspacePath()
 * Our extensions: init(), destroy(), writeFile(), readFile(), isReady()
 * Reason: host-side tools (query_traces, download_trace) run on the host
 * and need to write files into the sandbox via writeFile(), while the
 * sandbox itself has no network access.
 */
export interface Executor {
  /** Initialize the sandbox/container. Called lazily on first tool use. */
  init(): Promise<void>;

  /** Execute a shell command in the sandbox. Matches Mom's exec() signature. */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /** Get the workspace path prefix. Host: actual path. Docker: /workspace. */
  getWorkspacePath(): string;

  /** Write a file in the sandbox (extension beyond Mom — for host-side tools). */
  writeFile(path: string, content: string): Promise<void>;

  /** Read a file from the sandbox (extension beyond Mom — for host-side tools). */
  readFile(path: string): Promise<string>;

  /** Check if the executor has been initialized. */
  isReady(): boolean;

  /** Tear down the sandbox/container. */
  destroy(): Promise<void>;

  /**
   * Clone a git repository using native SDK support (optional).
   * Falls back to exec('git clone ...') if not implemented.
   */
  cloneRepo?(
    url: string,
    path: string,
    options?: {
      ref?: string;
      username?: string;
      password?: string;
    },
  ): Promise<void>;

  /** Whether this executor has native git support. */
  hasNativeGit?(): boolean;
}
