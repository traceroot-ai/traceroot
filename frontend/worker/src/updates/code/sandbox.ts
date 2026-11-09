import { spawn } from "node:child_process";

/**
 * Throwaway sandboxes for reading a customer's repository.
 *
 * Two kinds are made for one run. The clone sandbox has network access and
 * holds the token; it exists only to fetch the repository, copy it out and
 * die. The analysis sandbox is created with no network from the start (a
 * provider may only be able to cut egress at creation, so the flow does not
 * depend on cutting it later) and never sees the token. Both are destroyed in
 * every case, success or failure.
 */

export interface ExecOptions {
  /** Values handed to the command, referenced there as "$NAME"; never put in the command text. */
  env?: Record<string, string>;
  timeoutSec?: number;
}

export interface ExecOutput {
  code: number;
  stdout: string;
  /** True when the command was stopped for running over its time. */
  timedOut: boolean;
}

export interface SandboxHandle {
  id: string;
  networkAccess: boolean;
  exec(command: string, options?: ExecOptions): Promise<ExecOutput>;
  upload(path: string, data: Buffer): Promise<void>;
  download(path: string): Promise<Buffer>;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  readonly name: string;
  create(options: { networkAccess: boolean }): Promise<SandboxHandle>;
  /** Ids of the sandboxes this provider made that still exist; for checking nothing is left. */
  listLive(): Promise<string[]>;
}

// --- Docker -------------------------------------------------------------------

const DOCKER_LABEL = "traceroot.update-sandbox";

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

function run(
  args: string[],
  options: { env?: Record<string, string>; stdin?: Buffer; timeoutSec?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let err = "";
    let timedOut = false;
    const timer = options.timeoutSec
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutSec * 1000)
      : undefined;
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err, timedOut });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin);
  });
}

export interface DockerProviderOptions {
  /** An image with git, tar and a POSIX shell. */
  image?: string;
  /** Network the clone sandbox joins: "bridge" normally, "host" to reach a repository served on this machine. */
  cloneNetwork?: "bridge" | "host";
  /** Memory and CPU caps per container; leave a field out where the host cannot enforce it. */
  limits?: { memory?: string; cpus?: string };
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = "docker";
  private readonly image: string;
  private readonly cloneNetwork: string;
  private readonly limits: { memory?: string; cpus?: string };

  constructor(options: DockerProviderOptions = {}) {
    this.image = options.image ?? "alpine/git:latest";
    this.cloneNetwork = options.cloneNetwork ?? "bridge";
    this.limits = options.limits ?? { memory: "768m", cpus: "1" };
  }

  async create(options: { networkAccess: boolean }): Promise<SandboxHandle> {
    const network = options.networkAccess ? this.cloneNetwork : "none";
    const created = await run([
      "create",
      "--rm",
      "--label",
      `${DOCKER_LABEL}=1`,
      "--network",
      network,
      ...(this.limits.memory ? ["--memory", this.limits.memory] : []),
      ...(this.limits.cpus ? ["--cpus", this.limits.cpus] : []),
      "--pids-limit",
      "256",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--entrypoint",
      "sleep",
      this.image,
      "3600",
    ]);
    if (created.code !== 0) throw new Error(`Could not create a sandbox: ${created.stderr.trim()}`);
    const id = created.stdout.toString("utf8").trim().slice(0, 12);
    const started = await run(["start", id]);
    if (started.code !== 0) {
      // A container that was created but would not start must not be left behind.
      await run(["rm", "-f", id]);
      throw new Error(`Could not start a sandbox: ${started.stderr.trim()}`);
    }

    const exec = async (command: string, opts: ExecOptions = {}): Promise<ExecOutput> => {
      const envArgs = Object.keys(opts.env ?? {}).flatMap((k) => ["-e", k]);
      const result = await run(["exec", "-i", ...envArgs, id, "sh", "-c", command], {
        env: opts.env,
        timeoutSec: opts.timeoutSec,
      });
      return {
        code: result.timedOut ? 124 : result.code,
        stdout: result.stdout.toString("utf8") + (result.stderr ? `\n${result.stderr}` : ""),
        timedOut: result.timedOut,
      };
    };

    return {
      id,
      networkAccess: options.networkAccess,
      exec,
      async upload(path, data) {
        const result = await run(
          ["exec", "-i", "-e", "TARGET", id, "sh", "-c", 'cat > "$TARGET"'],
          {
            env: { TARGET: path },
            stdin: data,
          },
        );
        if (result.code !== 0) throw new Error(`Upload failed: ${result.stderr.trim()}`);
      },
      async download(path) {
        const result = await run(["exec", "-e", "TARGET", id, "sh", "-c", 'cat "$TARGET"'], {
          env: { TARGET: path },
        });
        if (result.code !== 0) throw new Error(`Download failed: ${result.stderr.trim()}`);
        return result.stdout;
      },
      async destroy() {
        await run(["rm", "-f", id]);
      },
    };
  }

  async listLive(): Promise<string[]> {
    const result = await run(["ps", "-aq", "--filter", `label=${DOCKER_LABEL}`]);
    return result.stdout
      .toString("utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }
}

// --- Daytona ------------------------------------------------------------------

/** The part of the Daytona SDK this provider uses, so it can be tested without the service. */
export interface DaytonaLike {
  create(
    params: {
      image: string;
      ephemeral: boolean;
      autoStopInterval: number;
      networkBlockAll: boolean;
      labels: Record<string, string>;
    },
    options: { timeout: number },
  ): Promise<DaytonaSandboxLike>;
  /** Pages through every sandbox matching the labels (SDK 0.2xx: an async iterator, not a page). */
  list(query?: { labels?: Record<string, string> }): AsyncIterable<{ id: string }>;
}

export interface DaytonaSandboxLike {
  id: string;
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{ exitCode?: number; result?: string }>;
  };
  fs: {
    uploadFile(data: Buffer, path: string): Promise<void>;
    downloadFile(path: string): Promise<Buffer>;
  };
  delete(): Promise<void>;
}

/** Fails to compile if the installed SDK drifts from what the provider relies on. */
export type SdkMatchesDaytonaLike = import("@daytonaio/sdk").Daytona extends {
  list(query?: { labels?: Record<string, string> }): AsyncIterable<{ id: string }>;
}
  ? true
  : never;
export const sdkMatchesDaytonaLike: SdkMatchesDaytonaLike = true;

const DAYTONA_LABELS = { "traceroot.update-sandbox": "true" };

/**
 * The same flow on Daytona. Network is blocked at creation (the SDK offers
 * nothing later), which is why the analysis sandbox is a second sandbox.
 */
export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = "daytona";

  constructor(
    private readonly daytona: DaytonaLike,
    private readonly image = "alpine/git:latest",
  ) {}

  async create(options: { networkAccess: boolean }): Promise<SandboxHandle> {
    const sandbox = await this.daytona.create(
      {
        image: this.image,
        ephemeral: true,
        autoStopInterval: 15,
        networkBlockAll: !options.networkAccess,
        labels: DAYTONA_LABELS,
      },
      { timeout: 90 },
    );
    return {
      id: sandbox.id,
      networkAccess: options.networkAccess,
      async exec(command, opts = {}) {
        const result = await sandbox.process.executeCommand(
          command,
          undefined,
          opts.env,
          opts.timeoutSec,
        );
        const code = result.exitCode ?? 1;
        // Daytona reports a command that ran out of time as a failed one; 124 is the shell's code for it.
        return { code, stdout: result.result ?? "", timedOut: code === 124 };
      },
      upload: (path, data) => sandbox.fs.uploadFile(data, path),
      download: (path) => sandbox.fs.downloadFile(path),
      destroy: () => sandbox.delete(),
    };
  }

  async listLive(): Promise<string[]> {
    const ids: string[] = [];
    for await (const sandbox of this.daytona.list({ labels: DAYTONA_LABELS })) ids.push(sandbox.id);
    return ids;
  }
}
