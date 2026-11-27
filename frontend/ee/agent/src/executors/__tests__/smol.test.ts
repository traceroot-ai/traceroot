import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the smolmachines SDK
const mockMachine = {
  name: "smol-test",
  exec: vi.fn(),
  writeFile: vi.fn(),
  delete: vi.fn(),
};

vi.mock("smolmachines", () => ({
  Machine: { create: vi.fn() },
}));

import { Machine } from "smolmachines";
import { SmolExecutor } from "../smol.js";
import { createExecutor } from "../index.js";

function execResult(stdout: string, exitCode = 0, stderr = "") {
  return { stdout, stderr, exitCode };
}

describe("SmolExecutor", () => {
  let executor: SmolExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Machine.create).mockResolvedValue(mockMachine as never);
    mockMachine.exec.mockResolvedValue(execResult(""));
    executor = new SmolExecutor();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { smolTarget: undefined, target: "cloud" },
    { smolTarget: "cloud", target: "cloud" },
    { smolTarget: "local", target: "local" },
  ])("runs on $target when SMOL_TARGET is $smolTarget", async ({ smolTarget, target }) => {
    vi.stubEnv("SMOL_TARGET", smolTarget);

    await executor.init();

    expect(Machine.create).toHaveBeenCalledWith(
      { image: "ubuntu:24.04", network: true, autoStopSeconds: 900, ttlSeconds: 86400 },
      { target },
    );
    expect(executor.isReady()).toBe(true);
    // git and the CA store must be there before cloneRepo runs.
    const apt = mockMachine.exec.mock.calls.map((c) => c[0][2]).find((c) => c.includes("apt-get"));
    expect(apt).toContain("ca-certificates");
    expect(apt).toContain("git");
    // Its exit code and stderr must reach init().
    expect(apt).not.toMatch(/\|\| true|2>/);
  });

  it.each([
    { step: "mkdir", fails: "exits 1", run: async () => execResult("", 1, "disk full") },
    { step: "apt-get", fails: "exits 100", run: async () => execResult("", 100, "disk full") },
    { step: "apt-get", fails: "throws", run: () => Promise.reject(new Error("disk full")) },
  ])("rejects init() and deletes the machine when $step $fails", async ({ step, run }) => {
    mockMachine.exec.mockImplementation(async (argv: string[]) =>
      argv[2].startsWith(step) ? run() : execResult(""),
    );
    mockMachine.delete.mockRejectedValueOnce(new Error("delete failed"));

    await expect(executor.init()).rejects.toThrow(new RegExp(`at "${step} .*disk full`));

    expect(mockMachine.delete).toHaveBeenCalledTimes(1);
    expect(executor.isReady()).toBe(false);
  });

  it("runs commands through sh with env out of argv and keeps the exit code", async () => {
    await executor.init();
    mockMachine.exec.mockResolvedValueOnce(execResult("out", 3, "err"));
    const signal = new AbortController().signal;

    const result = await executor.exec("make test", {
      env: { TOKEN: "s3cret" },
      timeout: 10,
      signal,
    });

    expect(result).toEqual({ stdout: "out", stderr: "err", code: 3 });
    expect(mockMachine.exec).toHaveBeenLastCalledWith(["sh", "-c", "make test"], {
      env: { TOKEN: "s3cret" },
      timeout: 10,
      signal,
    });
  });

  it("clones with the token and a hostile ref only in env", async () => {
    await executor.init();
    const hostile = 'main"; rm -rf / #';

    await executor.cloneRepo("https://github.com/foo/bar.git", "/workspace/repos/bar", {
      ref: hostile,
      password: "dummy_token",
    });

    expect(mockMachine.writeFile).toHaveBeenCalledWith(
      "/tmp/git-askpass.sh",
      expect.stringContaining("GIT_PASSWORD"),
    );
    const [argv, opts] = mockMachine.exec.mock.calls.find((c) => c[0][2].includes("clone"))!;
    expect(argv[2]).not.toContain("dummy_token");
    expect(argv[2]).not.toContain("rm -rf");
    expect(opts.env).toMatchObject({
      GIT_PASSWORD: "dummy_token",
      GIT_REF: hostile,
      GIT_URL: "https://github.com/foo/bar.git",
    });
    expect(executor.hasNativeGit()).toBe(true);
  });

  it("throws with git's output when the clone fails", async () => {
    await executor.init();
    mockMachine.exec.mockResolvedValue(execResult("fatal: repository not found", 128));

    await expect(
      executor.cloneRepo("https://github.com/foo/bar.git", "/workspace/repos/bar"),
    ).rejects.toThrow("fatal: repository not found");
  });

  it("deletes the machine once, even when the delete fails", async () => {
    await executor.destroy();
    expect(mockMachine.delete).not.toHaveBeenCalled();

    await executor.init();
    mockMachine.delete.mockRejectedValueOnce(new Error("network error"));
    await executor.destroy();
    await executor.destroy();

    expect(mockMachine.delete).toHaveBeenCalledTimes(1);
    expect(executor.isReady()).toBe(false);
  });

  it("is what createExecutor returns for SANDBOX_PROVIDER=smol", () => {
    vi.stubEnv("SANDBOX_PROVIDER", "smol");
    expect(createExecutor()).toBeInstanceOf(SmolExecutor);
  });
});
