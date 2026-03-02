import { Daytona } from "@daytonaio/sdk";
import type { Sandbox } from "@daytonaio/sdk";
import type { Executor, ExecResult, ExecOptions } from "./interface.js";

export class DaytonaExecutor implements Executor {
  private daytona: Daytona | null = null;
  private sandbox: Sandbox | null = null;
  private workDir = "";

  async init(): Promise<void> {
    console.log("[DaytonaExecutor] Creating sandbox...");

    this.daytona = new Daytona({
      apiKey: process.env.DAYTONA_API_KEY,
      apiUrl: "https://app.daytona.io/api",
      target: "us",
    });

    this.sandbox = await this.daytona.create(
      {
        image: "ubuntu:24.04",
        ephemeral: true,
        autoStopInterval: 15,
        labels: { "traceroot.session": "true" },
      },
      { timeout: 60 },
    );

    // Use /workspace consistently with DockerExecutor regardless of what Daytona reports
    this.workDir = "/workspace";
    await this.sandbox.process.executeCommand(
      "mkdir -p /workspace/repos /workspace/traces /workspace/notes",
    );

    // Install required tools
    await this.sandbox.process.executeCommand(
      "apt-get update -qq && apt-get install -y -qq git jq curl > /dev/null 2>&1 || true",
    );

    console.log(`[DaytonaExecutor] Sandbox ready, workDir: ${this.workDir}`);
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (!this.sandbox) throw new Error("Sandbox not initialized");

    const result = await this.sandbox.process.executeCommand(
      command,
      undefined,
      undefined,
      options?.timeout,
    );

    return {
      stdout: result.result ?? "",
      stderr: "",
      code: result.exitCode,
    };
  }

  getWorkspacePath(): string {
    return this.workDir;
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (!this.sandbox) throw new Error("Sandbox not initialized");
    await this.sandbox.fs.uploadFile(Buffer.from(content), path);
  }

  async readFile(path: string): Promise<string> {
    if (!this.sandbox) throw new Error("Sandbox not initialized");
    const buf = await this.sandbox.fs.downloadFile(path);
    return buf.toString();
  }

  isReady(): boolean {
    return this.sandbox !== null;
  }

  async destroy(): Promise<void> {
    if (!this.sandbox) return;
    console.log("[DaytonaExecutor] Destroying sandbox...");
    try {
      await this.sandbox.delete();
    } catch {
      // Ignore errors during cleanup
    }
    this.sandbox = null;
  }

  // Native Git Support

  hasNativeGit(): boolean {
    return true;
  }

  async cloneRepo(
    url: string,
    path: string,
    options?: { ref?: string; username?: string; password?: string },
  ): Promise<void> {
    if (!this.sandbox) throw new Error("Sandbox not initialized");

    // Daytona distinguishes branch/tag (3rd arg) from commit SHA (4th arg).
    // Passing a SHA as branch causes a 400 error from the API.
    const isCommitSha = options?.ref !== undefined && /^[0-9a-f]{7,40}$/i.test(options.ref);

    await this.sandbox.git.clone(
      url,
      path,
      isCommitSha ? undefined : options?.ref, // branch or tag
      isCommitSha ? options?.ref : undefined, // commit SHA
      options?.username || "x-access-token",
      options?.password,
    );
  }
}

/**
 * Set up gh CLI in a Daytona sandbox and authenticate with a GitHub token.
 * Uses native file upload instead of shell-based file writing.
 */
export async function setupGhCliDaytona(
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

  // Authenticate gh CLI via native file upload (avoids shell escaping issues with tokens)
  await executor.writeFile("/tmp/.gh_token", githubToken);
  await executor.exec("gh auth login --with-token < /tmp/.gh_token && rm /tmp/.gh_token");

  // Configure git identity
  const name = githubUsername || "TraceRoot Agent";
  const email = githubUsername
    ? `${githubUsername}@users.noreply.github.com`
    : "agent@traceroot.ai";
  await executor.exec(`git config --global user.name "${name}"`);
  await executor.exec(`git config --global user.email "${email}"`);
}
