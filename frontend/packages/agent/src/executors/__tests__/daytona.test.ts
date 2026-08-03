import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Daytona SDK
const mockSandbox = {
  process: {
    executeCommand: vi.fn(),
  },
  fs: {
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
  },
  git: {
    clone: vi.fn(),
  },
  getWorkDir: vi.fn(),
  delete: vi.fn(),
};

const mockDaytona = {
  create: vi.fn().mockResolvedValue(mockSandbox),
};

vi.mock("@daytonaio/sdk", () => ({
  Daytona: vi.fn().mockImplementation(() => mockDaytona),
}));

import { DaytonaExecutor } from "../daytona.js";

describe("DaytonaExecutor", () => {
  let executor: DaytonaExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new DaytonaExecutor();

    // Default mock returns
    mockSandbox.getWorkDir.mockResolvedValue("/home/daytona");
    mockSandbox.process.executeCommand.mockResolvedValue({
      exitCode: 0,
      result: "",
    });
  });

  describe("init()", () => {
    it("creates ephemeral sandbox from ubuntu:24.04 and caches workDir", async () => {
      await executor.init();

      expect(mockDaytona.create).toHaveBeenCalledWith(
        expect.objectContaining({
          image: "ubuntu:24.04",
          ephemeral: true,
          autoStopInterval: 15,
        }),
        expect.objectContaining({ timeout: 60 }),
      );
      // workDir is always /workspace regardless of what getWorkDir() returns
      expect(executor.getWorkspacePath()).toBe("/workspace");
      expect(executor.isReady()).toBe(true);
    });

    it("installs ca-certificates and git tooling at runtime", async () => {
      await executor.init();

      // ca-certificates must be present before any HTTPS clone (CLI git reads
      // the on-disk trust store), alongside git/jq/curl.
      const runtimeCmds = mockSandbox.process.executeCommand.mock.calls.map((c: [string]) => c[0]);
      const apt = runtimeCmds.find((c: string) => c.includes("apt-get"));
      expect(apt).toBeTruthy();
      expect(apt).toContain("ca-certificates");
      expect(apt).toContain("git");
    });
  });

  describe("exec()", () => {
    it("maps Daytona response to ExecResult", async () => {
      await executor.init();
      mockSandbox.process.executeCommand.mockResolvedValueOnce({
        exitCode: 0,
        result: "hello world",
      });

      const result = await executor.exec("echo hello world");

      expect(result).toEqual({
        stdout: "hello world",
        stderr: "",
        code: 0,
      });
    });

    it("passes timeout to executeCommand", async () => {
      await executor.init();
      mockSandbox.process.executeCommand.mockResolvedValueOnce({
        exitCode: 0,
        result: "",
      });

      await executor.exec("sleep 1", { timeout: 10 });

      expect(mockSandbox.process.executeCommand).toHaveBeenCalledWith(
        "sleep 1",
        undefined,
        undefined,
        10,
      );
    });

    it("throws if not initialized", async () => {
      await expect(executor.exec("ls")).rejects.toThrow("not initialized");
    });

    it("handles null result gracefully", async () => {
      await executor.init();
      mockSandbox.process.executeCommand.mockResolvedValueOnce({
        exitCode: 1,
        result: null,
      });

      const result = await executor.exec("false");

      expect(result).toEqual({ stdout: "", stderr: "", code: 1 });
    });
  });

  describe("writeFile()", () => {
    it("uploads content via fs.uploadFile", async () => {
      await executor.init();
      vi.clearAllMocks();

      await executor.writeFile("/tmp/test.txt", "hello");

      expect(mockSandbox.fs.uploadFile).toHaveBeenCalledWith(Buffer.from("hello"), "/tmp/test.txt");
    });

    it("creates the parent directory before uploading a nested path", async () => {
      // The download tools write into per-item subdirs that init() never creates
      // (e.g. /workspace/traces/<id>_<name>/); uploadFile does not create parents,
      // so writeFile must mkdir -p the parent first — and before the upload.
      await executor.init();
      vi.clearAllMocks();

      await executor.writeFile("/workspace/traces/t1_name/spans.jsonl", "{}\n");

      const mkdir = mockSandbox.process.executeCommand.mock.calls.find((c: [string]) =>
        c[0].startsWith("mkdir -p"),
      );
      expect(mkdir).toBeTruthy();
      expect(mkdir![0]).toBe("mkdir -p '/workspace/traces/t1_name'");
      // mkdir runs before the upload
      const mkdirOrder = mockSandbox.process.executeCommand.mock.invocationCallOrder[0];
      const uploadOrder = mockSandbox.fs.uploadFile.mock.invocationCallOrder[0];
      expect(mkdirOrder).toBeLessThan(uploadOrder);
      expect(mockSandbox.fs.uploadFile).toHaveBeenCalledWith(
        Buffer.from("{}\n"),
        "/workspace/traces/t1_name/spans.jsonl",
      );
    });

    it("does not mkdir for a root-level path", async () => {
      await executor.init();
      vi.clearAllMocks();

      await executor.writeFile("/foo.txt", "x");

      const mkdir = mockSandbox.process.executeCommand.mock.calls.find((c: [string]) =>
        c[0].startsWith("mkdir -p"),
      );
      expect(mkdir).toBeUndefined();
      expect(mockSandbox.fs.uploadFile).toHaveBeenCalledWith(Buffer.from("x"), "/foo.txt");
    });

    it("shell-escapes a parent dir containing single quotes", async () => {
      await executor.init();
      vi.clearAllMocks();

      await executor.writeFile("/workspace/traces/o'brien/spans.jsonl", "{}\n");

      const mkdir = mockSandbox.process.executeCommand.mock.calls.find((c: [string]) =>
        c[0].startsWith("mkdir -p"),
      );
      expect(mkdir![0]).toBe("mkdir -p '/workspace/traces/o'\\''brien'");
    });

    it("throws if not initialized", async () => {
      await expect(executor.writeFile("/tmp/x", "y")).rejects.toThrow("not initialized");
    });
  });

  describe("readFile()", () => {
    it("delegates to sandbox.fs.downloadFile()", async () => {
      await executor.init();
      mockSandbox.fs.downloadFile.mockResolvedValueOnce(Buffer.from("file contents"));

      const result = await executor.readFile("/tmp/test.txt");

      expect(result).toBe("file contents");
      expect(mockSandbox.fs.downloadFile).toHaveBeenCalledWith("/tmp/test.txt");
    });

    it("throws if not initialized", async () => {
      await expect(executor.readFile("/tmp/x")).rejects.toThrow("not initialized");
    });
  });

  describe("cloneRepo()", () => {
    // Deliberately uses the system `git` CLI (not go-git) with GIT_ASKPASS, so it
    // handles LFS/large repos and the token never lands in argv / URL / .git/config.

    /** Find the executeCommand call that runs `git ... clone` and return [cmd, cwd, env, timeout]. */
    function cloneCall() {
      const call = mockSandbox.process.executeCommand.mock.calls.find((c: [string]) =>
        c[0].includes("clone"),
      );
      expect(call).toBeTruthy();
      return call as [string, undefined, Record<string, string>, number];
    }

    it("writes an askpass helper and passes the token via env, never in argv", async () => {
      await executor.init();
      vi.clearAllMocks();
      mockSandbox.process.executeCommand.mockResolvedValue({ exitCode: 0, result: "" });

      await executor.cloneRepo("https://github.com/foo/bar.git", "/repos/bar", {
        ref: "main",
        username: "x-access-token",
        password: "dummy_token",
      });

      // askpass script uploaded
      const askpassUpload = mockSandbox.fs.uploadFile.mock.calls.find(
        (c: [Buffer, string]) => c[1] === "/tmp/git-askpass.sh",
      );
      expect(askpassUpload).toBeTruthy();
      expect((askpassUpload![0] as Buffer).toString()).toContain("GIT_PASSWORD");

      const [cmd, , env] = cloneCall();
      // url/dest/ref are referenced as quoted $VARS, never interpolated — so the
      // literal url is NOT in the command string; it flows through env instead.
      expect(cmd).toContain('"$GIT_URL"');
      expect(cmd).toContain('"$GIT_DEST"');
      expect(cmd).not.toContain("https://github.com/foo/bar.git");
      // token is NEVER in the command string
      expect(cmd).not.toContain("dummy_token");
      // creds + structured args flow through env
      expect(env).toMatchObject({
        GIT_ASKPASS: "/tmp/git-askpass.sh",
        GIT_TERMINAL_PROMPT: "0",
        GIT_USERNAME: "x-access-token",
        GIT_PASSWORD: "dummy_token",
        GIT_URL: "https://github.com/foo/bar.git",
        GIT_DEST: "/repos/bar",
        GIT_REF: "main",
      });
    });

    it("does not inject shell from a hostile ref", async () => {
      await executor.init();
      vi.clearAllMocks();
      mockSandbox.process.executeCommand.mockResolvedValue({ exitCode: 0, result: "" });

      const hostile = 'main"; rm -rf / #';
      await executor.cloneRepo("https://github.com/foo/bar.git", "/repos/bar", {
        ref: hostile,
        password: "dummy_token",
      });

      const [cmd, , env] = cloneCall();
      // hostile value never appears in the command string; only as an env value
      expect(cmd).not.toContain("rm -rf");
      expect(env.GIT_REF).toBe(hostile);
    });

    it("defaults username to x-access-token", async () => {
      await executor.init();
      await executor.cloneRepo("https://github.com/foo/bar.git", "/repos/bar", {
        password: "dummy_token",
      });
      const [, , env] = cloneCall();
      expect(env.GIT_USERNAME).toBe("x-access-token");
    });

    it("clones a branch with --branch (no checkout step)", async () => {
      await executor.init();
      await executor.cloneRepo("https://github.com/foo/bar.git", "/repos/bar", {
        ref: "main",
        password: "dummy_token",
      });
      const [cmd, , env] = cloneCall();
      expect(cmd).toContain('--branch "$GIT_REF"');
      expect(cmd).not.toContain("checkout");
      expect(env.GIT_REF).toBe("main");
    });

    it("clones then checks out a full commit SHA (not --branch)", async () => {
      await executor.init();
      const sha = "29b242d1b96aab9ac17e37350e6c7dc54033f61b";
      await executor.cloneRepo("https://github.com/foo/bar.git", "/repos/bar", {
        ref: sha,
        password: "dummy_token",
      });
      const [cmd, , env] = cloneCall();
      expect(cmd).not.toContain("--branch");
      expect(cmd).toContain('checkout "$GIT_REF"');
      expect(env.GIT_REF).toBe(sha);
    });

    it("treats a short hex ref as a SHA (checkout, not --branch)", async () => {
      await executor.init();
      await executor.cloneRepo("https://github.com/foo/bar.git", "/repos/bar", {
        ref: "29b242d",
        password: "dummy_token",
      });
      const [cmd, , env] = cloneCall();
      expect(cmd).not.toContain("--branch");
      expect(cmd).toContain('checkout "$GIT_REF"');
      expect(env.GIT_REF).toBe("29b242d");
    });

    it("shallow-clones the default branch when no ref is given", async () => {
      await executor.init();
      await executor.cloneRepo("https://github.com/foo/bar.git", "/repos/bar", {
        password: "dummy_token",
      });
      const [cmd] = cloneCall();
      expect(cmd).toContain("--depth 1");
      expect(cmd).not.toContain("--branch");
      expect(cmd).not.toContain("checkout");
    });

    it("throws a redacted error when the clone fails", async () => {
      await executor.init();
      vi.clearAllMocks();
      // chmod + clone both return non-zero; only the clone's exit is checked.
      mockSandbox.process.executeCommand.mockResolvedValue({
        exitCode: 128,
        result: "fatal: could not read Password dummy_token",
      });

      await expect(
        executor.cloneRepo("https://github.com/foo/bar.git", "/repos/bar", {
          password: "dummy_token",
        }),
      ).rejects.toThrow(/git clone failed.*\[REDACTED\]/s);
    });
  });

  describe("hasNativeGit()", () => {
    it("returns true", () => {
      expect(executor.hasNativeGit()).toBe(true);
    });
  });

  describe("destroy()", () => {
    it("deletes sandbox and resets state", async () => {
      await executor.init();
      expect(executor.isReady()).toBe(true);

      await executor.destroy();

      expect(mockSandbox.delete).toHaveBeenCalled();
      expect(executor.isReady()).toBe(false);
    });

    it("no-ops if not initialized", async () => {
      await executor.destroy(); // should not throw
      expect(mockSandbox.delete).not.toHaveBeenCalled();
    });

    it("swallows errors during delete", async () => {
      await executor.init();
      mockSandbox.delete.mockRejectedValueOnce(new Error("network error"));

      await executor.destroy(); // should not throw
      expect(executor.isReady()).toBe(false);
    });
  });
});
