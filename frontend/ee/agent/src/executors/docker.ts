import { spawn, execFile } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";
import type { Executor, ExecResult, ExecOptions } from "./interface.js";
import { ASKPASS_PATH, ASKPASS_SCRIPT, buildCloneCommand } from "./git-clone-command.js";

const execFileAsync = promisify(execFile);

const DOCKER_IMAGE = "ubuntu:24.04";
const WORKSPACE_DIR = "/workspace";
const CONTAINER_NAME_PREFIX = "traceroot-sandbox-";

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
   */
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (!this.containerId) throw new Error("Container not initialized");

    return new Promise((resolve) => {
      const executionId = randomUUID();
      const pidFile = "/tmp/traceroot-exec-" + executionId + ".pid";
      const cancelFile = "/tmp/traceroot-exec-" + executionId + ".cancel";
      const wrappedCommand = [
        "pid_file=$1",
        "cancel_file=$2",
        'if [ -e "$cancel_file" ]; then',
        '  rm -f "$cancel_file"',
        "  exit 1",
        "fi",
        "setsid --wait sh -c '" +
          "pid_file=$1; " +
          "cancel_file=$2; " +
          "command=$3; " +
          'printf "%s\\n" "$$" > "$pid_file"; ' +
          'if [ -e "$cancel_file" ]; then /bin/kill -KILL -- "-$$" 2>/dev/null || exit 1; fi; ' +
          'exec sh -c "$command"' +
          "' traceroot-command \"$pid_file\" \"$cancel_file\" \"$3\" &",
        "command_pid=$!",
        'if [ -e "$cancel_file" ]; then',
        '  if [ -s "$pid_file" ]; then',
        '    remote_pid=$(cat "$pid_file")',
        '    /bin/kill -KILL -- "-$remote_pid" 2>/dev/null || true',
        "  fi",
        "fi",
        'wait "$command_pid"',
        "command_status=$?",
        'rm -f "$pid_file" "$cancel_file"',
        'exit "$command_status"',
      ].join("\n");

      // Pass environment values by NAME only, never as literal command arguments.
      const envNames = Object.keys(options?.env ?? {});
      const child = spawn(
        "docker",
        [
          "exec",
          ...envNames.flatMap((name) => ["-e", name]),
          this.containerId!,
          "sh",
          "-c",
          wrappedCommand,
          "traceroot-exec",
          pidFile,
          cancelFile,
          command,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: options?.env ? { ...process.env, ...options.env } : process.env,
        },
      );

      let stdout = "";
      let stderr = "";
      let terminationReason: "timeout" | "cancelled" | null = null;
      const MAX_BYTES = 10 * 1024 * 1024;
      const timeoutMs = options?.timeout ? options.timeout * 1000 : 30000;

      const requestTermination = (reason: "timeout" | "cancelled") => {
        if (terminationReason) return;
        terminationReason = reason;
        void this.terminateRemoteCommand(pidFile, cancelFile).finally(() => {
          child.kill("SIGKILL");
        });
      };

      const timeoutHandle = setTimeout(() => requestTermination("timeout"), timeoutMs);
      const onAbort = () => requestTermination("cancelled");
      if (options?.signal) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        options?.signal?.removeEventListener("abort", onAbort);
      };

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > MAX_BYTES) stdout = stdout.slice(0, MAX_BYTES);
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
        if (stderr.length > MAX_BYTES) stderr = stderr.slice(0, MAX_BYTES);
      });

      const interruptedResult = (): ExecResult | undefined => {
        if (terminationReason === "timeout") {
          return {
            stdout,
            stderr: "Command timed out after " + timeoutMs / 1000 + "s",
            code: 1,
          };
        }
        if (terminationReason === "cancelled") {
          return {
            stdout,
            stderr: (stderr ? stderr + "\n" : "") + "Command cancelled",
            code: 1,
          };
        }
        return undefined;
      };

      child.on("close", (code) => {
        cleanup();
        const interrupted = interruptedResult();
        if (interrupted) {
          resolve(interrupted);
          return;
        }
        resolve({ stdout, stderr, code: code ?? 1 });
      });

      child.on("error", (err) => {
        cleanup();
        const interrupted = interruptedResult();
        resolve(interrupted ?? { stdout, stderr: err.message, code: 1 });
      });
    });
  }

  private terminateRemoteCommand(pidFile: string, cancelFile: string): Promise<void> {
    if (!this.containerId) return Promise.resolve();

    const terminateCommand = [
      "pid_file=$1",
      "cancel_file=$2",
      'touch "$cancel_file"',
      "attempt=0",
      'while [ "$attempt" -lt 40 ]; do',
      '  if [ -s "$pid_file" ]; then',
      '    command_pid=$(cat "$pid_file")',
      "    case \"$command_pid\" in",
      '      ""|*[!0-9]*) rm -f "$pid_file" "$cancel_file"; exit 0 ;;',
      "    esac",
      '    /bin/kill -KILL -- "-$command_pid" 2>/dev/null || true',
      '    rm -f "$pid_file" "$cancel_file"',
      "    exit 0",
      "  fi",
      '  if [ ! -e "$cancel_file" ]; then exit 0; fi',
      "  attempt=$((attempt + 1))",
      "  sleep 0.05",
      "done",
      "exit 0",
    ].join("\n");

    return new Promise((resolve) => {
      const killer = spawn(
        "docker",
        [
          "exec",
          this.containerId!,
          "sh",
          "-c",
          terminateCommand,
          "traceroot-cancel",
          pidFile,
          cancelFile,
        ],
        { stdio: "ignore" },
      );
      const finish = () => {
        clearTimeout(forceStopHandle);
        resolve();
      };
      const forceStopHandle = setTimeout(() => {
        killer.kill("SIGKILL");
        finish();
      }, 3000);
      killer.once("close", finish);
      killer.once("error", finish);
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
