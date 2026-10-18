import { spawn, execFile } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";
import type { Executor, ExecResult, ExecOptions } from "./interface.js";
import { ASKPASS_PATH, ASKPASS_SCRIPT, buildCloneCommand } from "./git-clone-command.js";

const execFileAsync = promisify(execFile);

const DOCKER_IMAGE = "ubuntu:24.04";
const WORKSPACE_DIR = "/workspace";
const CONTAINER_NAME_PREFIX = "traceroot-sandbox-";

// Keep the session leader alive until its remaining process-group members exit,
// including background grandchildren orphaned by the command shell. Ubuntu's
// base image has /proc but does not require ps/procps to be installed. Ignore
// zombies, which cannot execute and may briefly await the container's init reaper.
const COMMAND_WRAPPER = `
mkdir -p -m 700 "$1" || exit 1
trap 'rm -f "$1/pid"; rmdir "$1" 2>/dev/null || true' EXIT
printf '%s\\n' "$$" > "$1/pid" || exit 1
if [ -e "$1/cancelled" ]; then rm -f "$1/cancelled"; exit 1; fi
group_has_children() {
  for file in /proc/[0-9]*/stat; do
    [ "$file" != "/proc/$$/stat" ] || continue
    IFS= read -r stat 2>/dev/null < "$file" || continue
    fields=\${stat##*) }
    set -- $fields
    if [ "$3" = "$$" ] && [ "$1" != Z ]; then return 0; fi
  done
  return 1
}
sh -c "$2"
status=$?
while group_has_children; do sleep 0.05; done
exit "$status"
`;

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
      // Reap orphaned descendants after their command shell or group is killed.
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
   */
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (!this.containerId) throw new Error("Container not initialized");
    if (options?.signal?.aborted) {
      return { stdout: "", stderr: "Command aborted", code: 1 };
    }

    const containerId = this.containerId;
    const stateDir = `/tmp/traceroot-exec-${randomUUID()}`;

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
          containerId,
          "setsid",
          "--wait",
          "sh",
          "-c",
          // Publish the process-group leader before checking cancellation. If a
          // cancellation reaches Docker before this exec starts, its marker still
          // prevents the command from running. Positional arguments preserve the
          // caller's shell quoting and keep the generated path out of the command.
          COMMAND_WRAPPER,
          "traceroot-exec",
          stateDir,
          command,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: options?.env ? { ...process.env, ...options.env } : process.env,
        },
      );

      let stdout = "";
      let stderr = "";
      let cancellationMessage: string | undefined;
      let cancellation: Promise<void> | undefined;
      let terminationFailed = false;
      let finished = false;
      let hostKilled = false;
      let groupPublished = false;
      let hostKillHandle: ReturnType<typeof setTimeout> | undefined;
      const MAX_BYTES = 10 * 1024 * 1024; // 10MB, matches Mom

      const timeoutMs = options?.timeout ? options.timeout * 1000 : 30000;
      const cancel = (message: string) => {
        if (cancellation) return;
        cancellationMessage = message;
        // Killing the host-side docker client does not kill its remote command.
        // Mark cancellation first, then stop this exec's entire process group.
        cancellation = execFileAsync(
          "docker",
          [
            "exec",
            containerId,
            "sh",
            "-c",
            'mkdir -p -m 700 "$1" && touch "$1/cancelled" || exit 1; ' +
              'if [ -s "$1/pid" ] && read -r pid < "$1/pid"; then ' +
              'kill -KILL "-$pid" 2>/dev/null || true; printf started; fi',
            "traceroot-cancel",
            stateDir,
          ],
          { timeout: 5000 },
        )
          .then(({ stdout }) => {
            groupPublished = stdout === "started";
            // A process that escaped the group can keep Docker's output pipes
            // open. Bound the host client too, after attempting remote cleanup.
            if (!finished) {
              hostKillHandle = setTimeout(() => {
                hostKilled = true;
                child.kill("SIGKILL");
              }, 1000);
            }
          })
          .catch((error: Error) => {
            terminationFailed = true;
            cancellationMessage += `; could not terminate container command: ${error.message}`;
            child.kill("SIGKILL");
          });
      };
      const timeoutHandle = setTimeout(
        () => cancel(`Command timed out after ${timeoutMs / 1000}s`),
        timeoutMs,
      );
      const onAbort = () => cancel("Command aborted");
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      // The signal may have changed while spawn was starting the Docker client.
      if (options?.signal?.aborted) onAbort();

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > MAX_BYTES) stdout = stdout.slice(0, MAX_BYTES);
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
        if (stderr.length > MAX_BYTES) stderr = stderr.slice(0, MAX_BYTES);
      });

      const finish = async (code: number | null, error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutHandle);
        clearTimeout(hostKillHandle);
        options?.signal?.removeEventListener("abort", onAbort);
        await cancellation;
        // Normal completion cleans up in the launcher, without another Docker
        // call. A forced host kill only needs to retain the marker when the
        // launcher has not published its group yet. A published group was
        // already signaled and its state can be cleaned up even after fallback.
        if (cancellation && !terminationFailed && (!hostKilled || groupPublished)) {
          try {
            await execFileAsync(
              "docker",
              [
                "exec",
                containerId,
                "sh",
                "-c",
                'rm -f "$1/pid" "$1/cancelled"; rmdir "$1" 2>/dev/null || true',
                "traceroot-cleanup",
                stateDir,
              ],
              { timeout: 5000 },
            );
          } catch {
            // A removed container has already discarded its temporary state.
          }
        }
        resolve({
          stdout,
          stderr: cancellationMessage ?? error?.message ?? stderr,
          code: cancellationMessage || error ? 1 : (code ?? 1),
        });
      };
      child.on("close", (code) => void finish(code));
      child.on("error", (error) => void finish(1, error));
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
