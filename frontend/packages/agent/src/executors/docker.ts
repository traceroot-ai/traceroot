import { spawn, execFile } from "child_process";
import { promisify } from "util";
import type { Executor, ExecResult, ExecOptions } from "./interface.js";

const execFileAsync = promisify(execFile);

const DOCKER_IMAGE = process.env.SANDBOX_DOCKER_IMAGE || "ubuntu:24.04";
const WORKSPACE_DIR = "/workspace";

export class DockerExecutor implements Executor {
  private containerId: string | null = null;

  async init(): Promise<void> {
    console.log("[DockerExecutor] Creating container...");

    const { stdout } = await execFileAsync("docker", [
      "run",
      "-d",
      "--name",
      `traceroot-sandbox-${Date.now()}`,
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
      const child = spawn("docker", ["exec", this.containerId!, "sh", "-c", command], {
        stdio: ["ignore", "pipe", "pipe"],
      });

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
