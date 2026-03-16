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
    it("creates ephemeral sandbox and caches workDir", async () => {
      await executor.init();

      expect(mockDaytona.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ephemeral: true,
          autoStopInterval: 15,
        }),
        expect.objectContaining({ timeout: 60 }),
      );
      // workDir is always /workspace regardless of what getWorkDir() returns
      expect(executor.getWorkspacePath()).toBe("/workspace");
      expect(executor.isReady()).toBe(true);
    });

    it("installs required tools during init", async () => {
      await executor.init();

      expect(mockSandbox.process.executeCommand).toHaveBeenCalledWith(
        expect.stringContaining("apt-get"),
      );
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
    it("delegates to sandbox.fs.uploadFile()", async () => {
      await executor.init();
      await executor.writeFile("/tmp/test.txt", "hello");

      expect(mockSandbox.fs.uploadFile).toHaveBeenCalledWith(Buffer.from("hello"), "/tmp/test.txt");
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
    it("uses native sandbox.git.clone()", async () => {
      await executor.init();
      await executor.cloneRepo("https://github.com/foo/bar.git", "/repos/bar", {
        ref: "main",
        username: "x-access-token",
        password: "ghp_xxx",
      });

      expect(mockSandbox.git.clone).toHaveBeenCalledWith(
        "https://github.com/foo/bar.git",
        "/repos/bar",
        "main",
        undefined,
        "x-access-token",
        "ghp_xxx",
      );
    });

    it("defaults username to x-access-token", async () => {
      await executor.init();
      await executor.cloneRepo("https://github.com/foo/bar.git", "/repos/bar", {
        password: "ghp_xxx",
      });

      expect(mockSandbox.git.clone).toHaveBeenCalledWith(
        "https://github.com/foo/bar.git",
        "/repos/bar",
        undefined,
        undefined,
        "x-access-token",
        "ghp_xxx",
      );
    });

    it("passes commit SHA as commitId (4th arg), not branch", async () => {
      await executor.init();
      await executor.cloneRepo("https://github.com/foo/bar.git", "/repos/bar", {
        ref: "29b242d1b96aab9ac17e37350e6c7dc54033f61b",
        password: "ghp_xxx",
      });

      expect(mockSandbox.git.clone).toHaveBeenCalledWith(
        "https://github.com/foo/bar.git",
        "/repos/bar",
        undefined, // branch: undefined for SHAs
        "29b242d1b96aab9ac17e37350e6c7dc54033f61b", // commitId
        "x-access-token",
        "ghp_xxx",
      );
    });

    it("passes short SHA as commitId too", async () => {
      await executor.init();
      await executor.cloneRepo("https://github.com/foo/bar.git", "/repos/bar", {
        ref: "29b242d",
        password: "ghp_xxx",
      });

      expect(mockSandbox.git.clone).toHaveBeenCalledWith(
        "https://github.com/foo/bar.git",
        "/repos/bar",
        undefined,
        "29b242d",
        "x-access-token",
        "ghp_xxx",
      );
    });

    it("passes branch name as branch (3rd arg), not commitId", async () => {
      await executor.init();
      await executor.cloneRepo("https://github.com/foo/bar.git", "/repos/bar", {
        ref: "main",
        password: "ghp_xxx",
      });

      expect(mockSandbox.git.clone).toHaveBeenCalledWith(
        "https://github.com/foo/bar.git",
        "/repos/bar",
        "main", // branch
        undefined, // commitId: undefined for named branches
        "x-access-token",
        "ghp_xxx",
      );
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
