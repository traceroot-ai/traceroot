import { Machine } from "smolmachines";
import type { Executor, ExecResult, ExecOptions } from "./interface.js";
import { ASKPASS_PATH, ASKPASS_SCRIPT, buildCloneCommand } from "./git-clone-command.js";

export class SmolExecutor implements Executor {
  private machine: Machine | null = null;

  async init(): Promise<void> {
    console.log("[SmolExecutor] Creating machine...");

    const target = process.env.SMOL_TARGET === "local" ? "local" : "cloud";
    // Same base image and runtime tools as DaytonaExecutor; autoStopSeconds is its
    // autoStopInterval. A stopped machine is kept, so ttlSeconds deletes it a day
    // after creation. Both apply on the cloud and are ignored on a local machine.
    this.machine = await Machine.create(
      { image: "ubuntu:24.04", network: true, autoStopSeconds: 15 * 60, ttlSeconds: 24 * 60 * 60 },
      { target },
    );

    await this.setup("mkdir -p /workspace/repos /workspace/traces /workspace/notes");
    await this.setup(
      "apt-get update -qq && apt-get install -y -qq ca-certificates git jq curl > /dev/null",
    );

    console.log(`[SmolExecutor] Machine ready: ${this.machine.name}`);
  }

  // A failed step deletes the machine, so the next tool call runs init() again.
  private async setup(command: string): Promise<void> {
    try {
      const { code, stdout, stderr } = await this.exec(command);
      if (code !== 0) throw new Error(`exit code ${code}: ${stderr || stdout}`);
    } catch (err) {
      await this.destroy();
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Machine setup failed at "${command}": ${msg}`, { cause: err });
    }
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (!this.machine) throw new Error("Machine not initialized");

    // env travels over the guest agent connection, never in argv.
    const result = await this.machine.exec(["sh", "-c", command], {
      env: options?.env,
      timeout: options?.timeout,
      signal: options?.signal,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode };
  }

  getWorkspacePath(): string {
    return "/workspace";
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (!this.machine) throw new Error("Machine not initialized");
    await this.machine.writeFile(path, content);
  }

  async readFile(path: string): Promise<string> {
    if (!this.machine) throw new Error("Machine not initialized");
    return (await this.machine.readFile(path)).toString();
  }

  isReady(): boolean {
    return this.machine !== null;
  }

  hasNativeGit(): boolean {
    return true;
  }

  async destroy(): Promise<void> {
    if (!this.machine) return;
    console.log(`[SmolExecutor] Deleting machine ${this.machine.name}`);
    try {
      await this.machine.delete();
    } catch {
      // Ignore errors during cleanup
    }
    this.machine = null;
  }

  // Shared with DockerExecutor: caller-supplied values reach git only through env.
  async cloneRepo(
    url: string,
    path: string,
    options?: { ref?: string; username?: string; password?: string },
  ): Promise<void> {
    await this.writeFile(ASKPASS_PATH, ASKPASS_SCRIPT);
    await this.exec(`chmod +x ${ASKPASS_PATH}`);

    const { command, env } = buildCloneCommand({ url, dest: path, ...options });
    const result = await this.exec(command, { timeout: 180, env });
    if (result.code !== 0) {
      throw new Error(result.stdout || result.stderr || "git clone failed");
    }
  }
}
