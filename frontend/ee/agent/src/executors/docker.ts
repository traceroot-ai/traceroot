import { spawn, execFile } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";
import type { Executor, ExecResult, ExecOptions } from "./interface.js";
import { ASKPASS_PATH, ASKPASS_SCRIPT, buildCloneCommand } from "./git-clone-command.js";

const execFileAsync = promisify(execFile);

const DOCKER_IMAGE = "ubuntu:24.04";
const WORKSPACE_DIR = "/workspace";
const CONTAINER_NAME_PREFIX = "traceroot-sandbox-";

/**
 * Environment variable carrying a per-exec id. Every process a command starts
 * inherits it, including ones that leave the command's process group or
 * session, which is what lets stopCommand find all of them.
 */
const EXEC_ID_ENV = "TRACEROOT_EXEC_ID";
const ABORTED_MESSAGE = "Command aborted";
/** Upper bound on the `docker exec` that stops an interrupted command. */
const STOP_TIMEOUT_MS = 10_000;

/**
 * Runs the command (`$1`) unless stopCommand already marked it cancelled, which
 * happens when an abort reaches the container before this exec has started.
 */
const EXEC_WRAPPER = [
  `cancelled="/tmp/traceroot-exec-$${EXEC_ID_ENV}.cancelled"`,
  'if [ -e "$cancelled" ]; then rm -f "$cancelled"; exit 1; fi',
  'exec sh -c "$1"',
].join("\n");

/**
 * Kills every process carrying the exec id (`$1`), repeating until none is
 * left so that a child forked between a scan and its kill is caught by the
 * next scan. A killed process's environ reads empty, so it no longer matches.
 *
 * The cancelled marker covers an exec that has not started yet. Once a process
 * was found, the exec has started and is now dead, so the marker is removed.
 */
const STOP_SCRIPT = [
  'cancelled="/tmp/traceroot-exec-$1.cancelled"',
  'touch "$cancelled"',
  "found=0",
  "for _ in 1 2 3 4 5 6 7 8 9 10; do",
  `  pids=$(grep -lzx "${EXEC_ID_ENV}=$1" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3)`,
  '  [ -n "$pids" ] || break',
  "  found=1",
  "  kill -KILL $pids 2>/dev/null",
  "done",
  'if [ "$found" = 1 ]; then rm -f "$cancelled"; fi',
].join("\n");

/** Marks a container as an agent sandbox. Set on every container we create. */
export const SANDBOX_LABEL = "traceroot.sandbox";
/** The session a sandbox belongs to. */
export const SESSION_LABEL = "traceroot.session";
/** The agent instance that created a sandbox — the basis for reconciliation. */
export const OWNER_LABEL = "traceroot.owner";

export interface DockerExecutorOptions {
  /** Session this sandbox serves, recorded as a label for out-of-process lookup. */
  sessionId?: string;
  /**
   * Identifier of the agent instance that owns the sandbox. Startup
   * reconciliation removes every sandbox NOT carrying the current owner id, so
   * this must be unique per process (see reclaimOrphanedSandboxes).
   */
  ownerId?: string;
}

export class DockerExecutor implements Executor {
  private containerId: string | null = null;
  private readonly sessionId: string;
  private readonly ownerId: string;

  constructor(options: DockerExecutorOptions = {}) {
    this.sessionId = options.sessionId ?? "unknown";
    this.ownerId = options.ownerId ?? "unknown";
  }

  async init(): Promise<void> {
    console.log("[DockerExecutor] Creating container...");

    // Ownership also lives in labels, not just in the caller's in-memory map: a
    // crash, an OOM kill or a SIGKILL past the stop grace period leaves the
    // container running with no one holding a reference to it. Labels are what
    // let the next process find and reclaim it.
    const { stdout } = await execFileAsync("docker", [
      "run",
      "-d",
      // An init process reaps what a stopped command leaves behind; `sleep`
      // as PID 1 would keep every orphaned process as a zombie.
      "--init",
      "--name",
      `${CONTAINER_NAME_PREFIX}${Date.now()}`,
      "--label",
      `${SANDBOX_LABEL}=1`,
      "--label",
      `${SESSION_LABEL}=${this.sessionId}`,
      "--label",
      `${OWNER_LABEL}=${this.ownerId}`,
      // Network enabled — required for git clone and gh CLI (per design doc)
      // Token-based auth is ephemeral (1hr) and container is disposable
      "-w",
      WORKSPACE_DIR,
      DOCKER_IMAGE,
      "sleep",
      "infinity",
    ]);

    this.containerId = stdout.trim();

    // Create workspace directories
    await this.exec(`mkdir -p ${WORKSPACE_DIR}/traces ${WORKSPACE_DIR}/notes`);

    // Install basic tools if not in image
    await this.exec(
      "apt-get update -qq && apt-get install -y -qq git jq curl > /dev/null 2>&1 || true",
    );

    console.log(`[DockerExecutor] Container ready: ${this.containerId.slice(0, 12)}`);
  }

  /**
   * Execute a command in the container.
   * Follows Mom's pattern: spawn shell, capture stdout/stderr, support
   * timeout and AbortSignal, truncate output at 10MB.
   *
   * Killing the local `docker exec` client does not stop the command inside the
   * container, so a timeout or abort also stops it there (see stopCommand).
   */
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (!this.containerId) throw new Error("Container not initialized");
    const containerId = this.containerId;

    if (options?.signal?.aborted) {
      return { stdout: "", stderr: ABORTED_MESSAGE, code: 1 };
    }

    return new Promise((resolve) => {
      const execId = randomUUID();
      // Env values are passed to `docker exec` by NAME only (`-e KEY`), so the
      // value is inherited from this process's environment and never appears in
      // argv or `ps` output — matching the guarantee ExecOptions.env documents.
      // The exec id travels the same way and marks every process the command
      // starts, so stopCommand can find them.
      const env = { ...options?.env, [EXEC_ID_ENV]: execId };
      const child = spawn(
        "docker",
        [
          "exec",
          ...Object.keys(env).flatMap((name) => ["-e", name]),
          containerId,
          "sh",
          "-c",
          EXEC_WRAPPER,
          "sh",
          command,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...env },
        },
      );

      let stdout = "";
      let stderr = "";
      let interrupted: "timeout" | "abort" | null = null;
      let stopped: Promise<void> | undefined;
      const MAX_BYTES = 10 * 1024 * 1024; // 10MB, matches Mom

      // Stop the command inside the container first, then the client, which
      // may still be waiting on an output stream nothing is going to close.
      const interrupt = (reason: "timeout" | "abort") => {
        if (interrupted) return;
        interrupted = reason;
        stopped = stopCommand(containerId, execId).finally(() => child.kill("SIGKILL"));
      };

      // Timeout handling (like Mom's HostExecutor)
      const timeoutMs = options?.timeout ? options.timeout * 1000 : 30000;
      const timeoutHandle = setTimeout(() => interrupt("timeout"), timeoutMs);

      // AbortSignal support (like Mom)
      const onAbort = () => interrupt("abort");
      options?.signal?.addEventListener("abort", onAbort, { once: true });

      const finish = (result: ExecResult) => {
        clearTimeout(timeoutHandle);
        options?.signal?.removeEventListener("abort", onAbort);
        // Resolve only once the command is gone from the container, so nothing
        // it started can still write to the workspace after exec() returns.
        void Promise.resolve(stopped).then(() => resolve(result));
      };

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > MAX_BYTES) stdout = stdout.slice(0, MAX_BYTES);
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
        if (stderr.length > MAX_BYTES) stderr = stderr.slice(0, MAX_BYTES);
      });

      child.on("close", (code) => {
        if (interrupted === "timeout") {
          finish({ stdout, stderr: `Command timed out after ${timeoutMs / 1000}s`, code: 1 });
          return;
        }
        if (interrupted === "abort") {
          finish({
            stdout,
            stderr: stderr ? `${stderr}\n${ABORTED_MESSAGE}` : ABORTED_MESSAGE,
            code: 1,
          });
          return;
        }
        // A null code means the client was killed by a signal: not a success.
        finish({ stdout, stderr, code: code ?? 1 });
      });

      child.on("error", (err) => {
        finish({ stdout, stderr: err.message, code: 1 });
      });
    });
  }

  getWorkspacePath(): string {
    return WORKSPACE_DIR; // Docker container always sees /workspace
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (!this.containerId) throw new Error("Container not initialized");
    const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : ".";
    await this.exec(`mkdir -p ${shellEscape(dir)}`);
    await this.exec(`printf '%s' ${shellEscape(content)} > ${shellEscape(path)}`);
  }

  async readFile(path: string): Promise<string> {
    const result = await this.exec(`cat ${shellEscape(path)}`);
    if (result.code !== 0) throw new Error(`File not found: ${path}`);
    return result.stdout;
  }

  isReady(): boolean {
    return this.containerId !== null;
  }

  hasNativeGit(): boolean {
    return true;
  }

  /**
   * Clone via the system `git` CLI. Shares its command construction with the
   * Daytona executor (see git-clone-command.ts): every caller-supplied value
   * travels through the environment and is referenced as a quoted "$VAR", so a
   * hostile ref cannot break quoting or inject shell, and the token never
   * reaches argv, the clone URL, or .git/config.
   */
  async cloneRepo(
    url: string,
    path: string,
    options?: { ref?: string; username?: string; password?: string },
  ): Promise<void> {
    if (!this.containerId) throw new Error("Container not initialized");

    await this.writeFile(ASKPASS_PATH, ASKPASS_SCRIPT);
    await this.exec(`chmod +x ${shellEscape(ASKPASS_PATH)}`);

    const { command, env } = buildCloneCommand({
      url,
      dest: path,
      ref: options?.ref,
      username: options?.username,
      password: options?.password,
    });

    const result = await this.exec(command, { timeout: 180, env });
    if (result.code !== 0) {
      throw new Error(result.stdout || result.stderr || "git clone failed");
    }
  }

  async destroy(): Promise<void> {
    if (!this.containerId) return;
    console.log(`[DockerExecutor] Destroying container ${this.containerId.slice(0, 12)}`);
    try {
      await execFileAsync("docker", ["rm", "-f", this.containerId]);
    } catch {
      // Ignore errors during cleanup
    }
    this.containerId = null;
  }
}

/**
 * Remove every agent sandbox on this Docker host that the current instance does
 * not own.
 *
 * Ownership used to live only in the agent's in-memory map, so any exit short of
 * a fully completed graceful shutdown — a crash, an OOM kill, a SIGKILL after
 * the stop grace period — orphaned every container the process had created, and
 * the next process had no way to name them. Reconciling at startup makes a
 * restart the reliable sweeper.
 *
 * Matching is by name prefix rather than by label so that sandboxes created
 * before labels existed are reclaimed too; a container is spared only when it
 * carries the current owner id, which no other process can have. That makes
 * this safe only with one agent per Docker host: another live agent's
 * sandboxes are removed too. See reclaimOnStartFromEnv for the opt-out.
 */
export async function reclaimOrphanedSandboxes(ownerId: string): Promise<string[]> {
  let listed: string;
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps",
      "-a",
      "--filter",
      `name=${CONTAINER_NAME_PREFIX}`,
      "--format",
      `{{.ID}} {{.Names}} {{.Label "${OWNER_LABEL}"}}`,
    ]);
    listed = stdout;
  } catch (error) {
    // No docker socket (Daytona deployments, CI) is not a failure — there is
    // simply nothing to reclaim, and startup must not depend on it.
    console.warn(`[DockerExecutor] Could not list sandbox containers: ${String(error)}`);
    return [];
  }

  const orphaned = listed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, names, owner] = line.split(/\s+/);
      return { id, names: (names ?? "").split(","), owner };
    })
    // `docker ps --filter name=` matches a substring, not a prefix, so a
    // container someone else called "my-traceroot-sandbox-notes" is listed here
    // and — carrying no owner label — would read as an orphan. Force-removing a
    // container we did not create is not a risk worth taking for a sweep, so the
    // name is re-checked exactly. A container can carry several names; ours is
    // created with one, and any name matching the prefix identifies it.
    .filter(({ names }) => names.some((name) => name.startsWith(CONTAINER_NAME_PREFIX)))
    .filter(({ owner }) => owner !== ownerId)
    .map(({ id }) => id);

  if (orphaned.length === 0) return [];

  console.log(`[DockerExecutor] Reclaiming ${orphaned.length} orphaned sandbox container(s)`);
  try {
    await execFileAsync("docker", ["rm", "-f", ...orphaned]);
  } catch (error) {
    // A container removed by someone else between the list and the remove fails
    // the whole batch; the next restart retries.
    console.warn(`[DockerExecutor] Failed to remove orphaned sandboxes: ${String(error)}`);
  }
  return orphaned;
}

/**
 * Stop an interrupted exec inside the container: every process it started, not
 * just the `docker exec` client on this host. A failure is logged rather than
 * thrown; the caller still kills the client and reports the interruption.
 */
async function stopCommand(containerId: string, execId: string): Promise<void> {
  try {
    await execFileAsync("docker", ["exec", containerId, "sh", "-c", STOP_SCRIPT, "sh", execId], {
      timeout: STOP_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    console.warn(`[DockerExecutor] Failed to stop command ${execId}: ${String(error)}`);
  }
}

/**
 * Set up gh CLI in a Docker container and authenticate with a GitHub token.
 * Call this when the agent needs GitHub CLI access in the sandbox.
 */
export async function setupGhCli(
  executor: Executor,
  githubToken: string,
  githubUsername?: string,
): Promise<void> {
  // Install gh CLI if not present
  await executor.exec(
    `
    type gh >/dev/null 2>&1 || {
      apt-get update -qq
      apt-get install -y -qq curl
      curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
      chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        | tee /etc/apt/sources.list.d/github-cli.list >/dev/null
      apt-get update -qq
      apt-get install -y -qq gh
    }
  `,
    { timeout: 120 },
  );

  // Authenticate gh CLI (write token to temp file, auth, then delete)
  await executor.writeFile("/tmp/.gh_token", githubToken);
  await executor.exec("gh auth login --with-token < /tmp/.gh_token && rm /tmp/.gh_token");

  // Configure git identity for commits
  const name = githubUsername || "TraceRoot Agent";
  const email = githubUsername
    ? `${githubUsername}@users.noreply.github.com`
    : "agent@traceroot.ai";
  await executor.exec(`git config --global user.name "${name}"`);
  await executor.exec(`git config --global user.email "${email}"`);
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
