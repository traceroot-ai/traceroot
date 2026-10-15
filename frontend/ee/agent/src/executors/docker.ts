import { spawn, execFile } from "child_process";
import { promisify } from "util";
import type { Executor, ExecResult, ExecOptions } from "./interface.js";
import { ASKPASS_PATH, ASKPASS_SCRIPT, buildCloneCommand } from "./git-clone-command.js";
import {
  agentInstanceId,
  isAlreadyRemoved,
  removeSandboxContainer,
  sandboxContainerName,
  sandboxRunLabelArgs,
} from "./sandbox-lifecycle.js";

const execFileAsync = promisify(execFile);

const DOCKER_IMAGE = "ubuntu:24.04";
const WORKSPACE_DIR = "/workspace";

export class DockerExecutor implements Executor {
  private containerId: string | null = null;
  private readonly sessionId?: string;
  private readonly ownerId: string;

  constructor(options?: { sessionId?: string; ownerId?: string }) {
    this.sessionId = options?.sessionId;
    this.ownerId = options?.ownerId ?? agentInstanceId();
  }

  /**
   * Serializes init against destroy. Without it, a destroy racing an
   * in-flight init can run while `containerId` is still null (a no-op) and
   * the init then finishes creating a container nobody owns — leaked at
   * shutdown. Chained this way, destroy either precedes init (which then
   * refuses via `destroyedFlag`) or follows it (and removes the container).
   */
  private lifecycle: Promise<void> = Promise.resolve();
  private destroyedFlag = false;

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(fn);
    // The chain itself never rejects — each caller still sees its own
    // outcome — so one failure cannot wedge later lifecycle calls.
    this.lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async init(): Promise<void> {
    return this.runExclusive(async () => {
      if (this.destroyedFlag) {
        throw new Error("executor was destroyed before initialization");
      }
      return this.initInner();
    });
  }

  private async initInner(): Promise<void> {
    console.log("[DockerExecutor] Creating container...");

    const containerName = sandboxContainerName();
    let containerId: string;
    try {
      // Labels travel as separate argv entries (execFile, no shell), so a
      // hostile session id can never inject — and an invalid one is simply
      // omitted by sandboxRunLabelArgs rather than refused.
      const { stdout } = await execFileAsync("docker", [
        "run",
        "-d",
        "--name",
        containerName,
        ...sandboxRunLabelArgs(this.sessionId, this.ownerId),
        // Network enabled — required for git clone and gh CLI (per design doc)
        // Token-based auth is ephemeral (1hr) and container is disposable
        "-w",
        WORKSPACE_DIR,
        DOCKER_IMAGE,
        "sleep",
        "infinity",
      ]);
      containerId = stdout.trim();
      if (!containerId) throw new Error("docker run produced no container id");
    } catch (error) {
      // `docker run` itself failed: nothing was started (or the id was
      // never reported), so there is nothing to reclaim — surface the cause.
      throw error instanceof Error ? error : new Error(String(error));
    }

    this.containerId = containerId;

    try {
      // Create workspace directories. exec() resolves — never rejects — on
      // command failure, so the exit code must be checked explicitly: a
      // failed mkdir must throw here, not report a ready container.
      const workspace = await this.exec(`mkdir -p ${WORKSPACE_DIR}/traces ${WORKSPACE_DIR}/notes`);
      if (workspace.code !== 0) {
        throw new Error(initFailureMessage("workspace directories", workspace));
      }

      // Install basic tools if not in image. Best-effort by policy (`|| true`
      // keeps the shell exit zero): a tool-install failure must not fail
      // sandbox creation here — that readiness question belongs to #1462.
      await this.exec(
        "apt-get update -qq && apt-get install -y -qq git jq curl > /dev/null 2>&1 || true",
      );
    } catch (error) {
      // The container exists but never became usable. Without this pass it
      // would leak: nothing tracks it yet outside this instance.
      const leaked = this.containerId;
      this.containerId = null;
      try {
        await removeSandboxContainer(leaked);
      } catch (cleanupError) {
        // The caller still sees the setup failure below; the reclaim failure
        // is logged here, and the startup reconciler retries it next boot.
        console.error(
          `[DockerExecutor] Failed to reclaim partially initialized container ${leaked.slice(0, 12)}:`,
          cleanupError,
        );
      }
      throw error instanceof Error ? error : new Error(String(error));
    }

    console.log(`[DockerExecutor] Container ready: ${this.containerId.slice(0, 12)}`);
  }

  /**
   * Execute a command in the container.
   * Follows Mom's pattern: spawn shell, capture stdout/stderr, support
   * timeout and AbortSignal, truncate output at 10MB.
   */
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (!this.containerId) throw new Error("Container not initialized");

    return new Promise((resolve) => {
      // Env values are passed to `docker exec` by NAME only (`-e KEY`), so the
      // value is inherited from this process's environment and never appears in
      // argv or `ps` output — matching the guarantee ExecOptions.env documents.
      const envNames = Object.keys(options?.env ?? {});
      const child = spawn(
        "docker",
        [
          "exec",
          ...envNames.flatMap((name) => ["-e", name]),
          this.containerId!,
          "sh",
          "-c",
          command,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: options?.env ? { ...process.env, ...options.env } : process.env,
        },
      );

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const MAX_BYTES = 10 * 1024 * 1024; // 10MB, matches Mom

      // Timeout handling (like Mom's HostExecutor)
      const timeoutMs = options?.timeout ? options.timeout * 1000 : 30000;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      // AbortSignal support (like Mom)
      if (options?.signal) {
        const onAbort = () => child.kill("SIGKILL");
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > MAX_BYTES) stdout = stdout.slice(0, MAX_BYTES);
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
        if (stderr.length > MAX_BYTES) stderr = stderr.slice(0, MAX_BYTES);
      });

      child.on("close", (code) => {
        clearTimeout(timeoutHandle);
        if (timedOut) {
          resolve({ stdout, stderr: `Command timed out after ${timeoutMs / 1000}s`, code: 1 });
          return;
        }
        resolve({ stdout, stderr, code: code ?? 0 });
      });

      child.on("error", (err) => {
        clearTimeout(timeoutHandle);
        resolve({ stdout, stderr: err.message, code: 1 });
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
    await this.runExclusive(async () => {
      this.destroyedFlag = true;
      return this.destroyInner();
    });
  }

  private async destroyInner(): Promise<void> {
    if (!this.containerId) return;
    const id = this.containerId;
    console.log(`[DockerExecutor] Destroying container ${id.slice(0, 12)}`);
    try {
      await execFileAsync("docker", ["rm", "-f", id], { timeout: 15_000 });
    } catch (error) {
      // An already-absent container is the steady state (double delete,
      // reconciler won the race) — not a failure. Anything else is real: log
      // loudly and surface it so shutdown exits non-zero instead of
      // reporting success while the container is still on the host.
      if (isAlreadyRemoved(error)) {
        this.containerId = null;
        return;
      }
      console.error(`[DockerExecutor] Failed to remove container ${id.slice(0, 12)}:`, error);
      this.containerId = null;
      throw error instanceof Error ? error : new Error(String(error));
    }
    this.containerId = null;
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

/** How much failed-setup output survives into the init error — a diagnostic, never a dump. */
const SETUP_DIAGNOSTIC_CHARS = 2000;

/**
 * A meaningful init error for a setup step whose command resolved nonzero.
 * Prefers stderr (where the shell reports the cause) with stdout as fallback,
 * bounded so a chatty failure cannot flood the turn that surfaces it.
 */
function initFailureMessage(step: string, result: ExecResult): string {
  const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, SETUP_DIAGNOSTIC_CHARS);
  return `sandbox setup failed at ${step} (exit ${result.code})${detail ? `: ${detail}` : ""}`;
}
