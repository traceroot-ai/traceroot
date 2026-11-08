import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import type { ExecOptions, ExecOutput, SandboxHandle, SandboxProvider } from "./sandbox.js";

/**
 * A stand-in sandbox that runs commands in this process's own environment.
 * It exists to test the orchestration (limits, fallbacks, cleanup, what
 * reaches a command) quickly and offline. It isolates nothing, so it never
 * counts as proof of a safety property: the Docker provider does that.
 */
export class LocalShellSandboxProvider implements SandboxProvider {
  readonly name = "local-shell";
  readonly created: { id: string; networkAccess: boolean }[] = [];
  private live = new Set<string>();
  private counter = 0;

  async create(options: { networkAccess: boolean }): Promise<SandboxHandle> {
    const id = `local-${(this.counter += 1)}`;
    this.created.push({ id, networkAccess: options.networkAccess });
    this.live.add(id);
    return {
      id,
      networkAccess: options.networkAccess,
      exec: (command, opts) => execLocal(command, opts),
      upload: (path, data) => fs.writeFile(path, data),
      download: (path) => fs.readFile(path),
      destroy: async () => {
        this.live.delete(id);
      },
    };
  }

  async listLive(): Promise<string[]> {
    return [...this.live];
  }
}

function execLocal(command: string, opts: ExecOptions = {}): Promise<ExecOutput> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let timedOut = false;
    const timer = opts.timeoutSec
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutSec * 1000)
      : undefined;
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout: out, timedOut });
    });
  });
}
