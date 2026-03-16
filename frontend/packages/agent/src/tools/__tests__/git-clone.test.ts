import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Executor, ExecResult } from "../../executors/interface.js";
import { createGitCloneTool } from "../git-clone.js";

// Helper to create a mock executor
function createMockExecutor(overrides?: Partial<Executor>): Executor {
  return {
    init: vi.fn(),
    exec: vi.fn<(cmd: string) => Promise<ExecResult>>().mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
    }),
    getWorkspacePath: vi.fn().mockReturnValue("/workspace"),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
    destroy: vi.fn(),
    ...overrides,
  };
}

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("git_clone tool", () => {
  const userId = "user-123";
  const uiBaseUrl = "http://localhost:3000";
  const token = "ghs_test_token_123";
  const githubUsername = "testuser";

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: token endpoint returns valid token
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ token, github_username: githubUsername }),
    });
  });

  describe("native git path (Daytona)", () => {
    it("uses cloneRepo() when executor has native git", async () => {
      const cloneRepo = vi.fn();
      const exec = vi.fn<(cmd: string) => Promise<ExecResult>>().mockResolvedValue({
        stdout: "abc1234 Initial commit",
        stderr: "",
        code: 0,
      });
      const executor = createMockExecutor({
        hasNativeGit: () => true,
        cloneRepo,
        exec,
      });

      const tool = createGitCloneTool(userId, uiBaseUrl, executor);
      const result = await tool.execute("call-1", {
        label: "Clone test repo",
        repo: "owner/repo",
      });

      // Should use native cloneRepo, NOT exec with git clone
      expect(cloneRepo).toHaveBeenCalledWith(
        "https://github.com/owner/repo.git",
        "/workspace/repos/owner_repo",
        {
          ref: undefined,
          username: "x-access-token",
          password: token,
        },
      );

      // Should NOT have called exec with a git clone command
      const execCalls = exec.mock.calls.map((c) => c[0]);
      expect(execCalls.some((cmd) => cmd.includes("git clone"))).toBe(false);

      // Should still call exec for mkdir and git log
      expect(execCalls.some((cmd) => cmd.includes("mkdir"))).toBe(true);
      expect(execCalls.some((cmd) => cmd.includes("git log"))).toBe(true);

      // Result should include clone success info
      expect((result.content[0] as { text: string }).text).toContain("Cloned owner/repo");
    });

    it("passes ref to cloneRepo()", async () => {
      const cloneRepo = vi.fn();
      const executor = createMockExecutor({
        hasNativeGit: () => true,
        cloneRepo,
        exec: vi.fn<(cmd: string) => Promise<ExecResult>>().mockResolvedValue({
          stdout: "abc1234 Some commit",
          stderr: "",
          code: 0,
        }),
      });

      const tool = createGitCloneTool(userId, uiBaseUrl, executor);
      await tool.execute("call-1", {
        label: "Clone with ref",
        repo: "owner/repo",
        ref: "feature-branch",
      });

      expect(cloneRepo).toHaveBeenCalledWith(
        "https://github.com/owner/repo.git",
        "/workspace/repos/owner_repo",
        {
          ref: "feature-branch",
          username: "x-access-token",
          password: token,
        },
      );
    });
  });

  describe("exec fallback path (Docker)", () => {
    it("uses exec git clone when no native git", async () => {
      const exec = vi.fn<(cmd: string) => Promise<ExecResult>>().mockResolvedValue({
        stdout: "abc1234 Initial commit",
        stderr: "",
        code: 0,
      });
      const executor = createMockExecutor({ exec });

      const tool = createGitCloneTool(userId, uiBaseUrl, executor);
      await tool.execute("call-1", {
        label: "Clone test repo",
        repo: "owner/repo",
      });

      // Should use exec with git clone
      const execCalls = exec.mock.calls.map((c) => c[0]);
      expect(execCalls.some((cmd) => cmd.includes("git clone"))).toBe(true);
    });

    it("uses exec git clone with ref", async () => {
      const exec = vi.fn<(cmd: string) => Promise<ExecResult>>().mockResolvedValue({
        stdout: "abc1234 Initial commit",
        stderr: "",
        code: 0,
      });
      const executor = createMockExecutor({ exec });

      const tool = createGitCloneTool(userId, uiBaseUrl, executor);
      await tool.execute("call-1", {
        label: "Clone with ref",
        repo: "owner/repo",
        ref: "v1.0",
      });

      const execCalls = exec.mock.calls.map((c) => c[0]);
      const cloneCall = execCalls.find((cmd) => cmd.includes("git clone"));
      expect(cloneCall).toBeDefined();
      expect(cloneCall).toContain("v1.0");
    });
  });

  describe("error handling", () => {
    it("returns error when GitHub App not installed", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false });
      const executor = createMockExecutor();

      const tool = createGitCloneTool(userId, uiBaseUrl, executor);
      const result = await tool.execute("call-1", {
        label: "Clone",
        repo: "owner/repo",
      });

      expect((result.content[0] as { text: string }).text).toContain("No GitHub App installed");
    });

    it("sanitizes token from error output on clone failure (exec path)", async () => {
      const exec = vi
        .fn<(cmd: string) => Promise<ExecResult>>()
        .mockImplementation(async (cmd: string) => {
          if (cmd.includes("git clone")) {
            return {
              stdout: "",
              stderr: `fatal: could not read from ${token}`,
              code: 128,
            };
          }
          return { stdout: "", stderr: "", code: 0 };
        });
      const executor = createMockExecutor({ exec });

      const tool = createGitCloneTool(userId, uiBaseUrl, executor);
      const result = await tool.execute("call-1", {
        label: "Clone",
        repo: "owner/repo",
      });

      expect((result.content[0] as { text: string }).text).toContain("Clone failed");
      expect((result.content[0] as { text: string }).text).not.toContain(token);
      expect((result.content[0] as { text: string }).text).toContain("[REDACTED]");
    });

    it("returns error when native cloneRepo fails", async () => {
      const cloneRepo = vi.fn().mockRejectedValue(new Error("clone failed"));
      const exec = vi.fn<(cmd: string) => Promise<ExecResult>>().mockResolvedValue({
        stdout: "",
        stderr: "",
        code: 0,
      });
      const executor = createMockExecutor({
        hasNativeGit: () => true,
        cloneRepo,
        exec,
      });

      const tool = createGitCloneTool(userId, uiBaseUrl, executor);
      const result = await tool.execute("call-1", {
        label: "Clone",
        repo: "owner/repo",
      });

      expect((result.content[0] as { text: string }).text).toContain("Clone failed");
    });
  });

  describe("gh CLI setup", () => {
    it("calls setupGhCli after successful clone", async () => {
      const exec = vi.fn<(cmd: string) => Promise<ExecResult>>().mockResolvedValue({
        stdout: "abc1234 Initial commit",
        stderr: "",
        code: 0,
      });
      const executor = createMockExecutor({ exec });

      const tool = createGitCloneTool(userId, uiBaseUrl, executor);
      await tool.execute("call-1", {
        label: "Clone",
        repo: "owner/repo",
      });

      // setupGhCli calls should include gh auth and git config
      const execCalls = exec.mock.calls.map((c) => c[0]);
      expect(execCalls.some((cmd) => cmd.includes("gh"))).toBe(true);
    });
  });
});
