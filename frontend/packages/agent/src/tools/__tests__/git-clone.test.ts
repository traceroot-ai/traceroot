import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Executor } from "../../executors/interface.js";

vi.mock("../../executors/docker.js", () => ({
  setupGhCli: vi.fn(async () => {}),
}));

vi.mock("../../executors/daytona.js", () => ({
  setupGhCliDaytona: vi.fn(async () => {}),
}));

import { createGitCloneTool } from "../git-clone.js";

function textFrom(result: Awaited<ReturnType<ReturnType<typeof createGitCloneTool>["execute"]>>) {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function createExecutor(): Executor & { exec: ReturnType<typeof vi.fn>; writeFile: ReturnType<typeof vi.fn> } {
  return {
    init: vi.fn(async () => {}),
    exec: vi.fn(async (command: string) => {
      if (command.includes("git log")) return { stdout: "abc123 commit subject\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }),
    getWorkspacePath: () => "/workspace",
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ""),
    isReady: () => true,
    destroy: vi.fn(async () => {}),
    hasNativeGit: () => false,
  };
}

describe("git_clone tool", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ token: "ghs_secret_token", github_username: "octocat" }),
      })),
    );
  });

  it("rejects repositories outside owner/repo format before fetching a token", async () => {
    const executor = createExecutor();
    const tool = createGitCloneTool("ws_1", "http://ui.test", executor);

    const result = await tool.execute("call_1", {
      label: "clone hostile repo",
      repo: 'owner/repo"; touch /tmp/pwned #',
    });

    expect(textFrom(result)).toContain("Invalid repository");
    expect(fetch).not.toHaveBeenCalled();
    expect(executor.exec).not.toHaveBeenCalled();
  });

  it("rejects refs containing shell metacharacters before executing git", async () => {
    const executor = createExecutor();
    const tool = createGitCloneTool("ws_1", "http://ui.test", executor);

    const result = await tool.execute("call_1", {
      label: "clone hostile ref",
      repo: "owner/repo",
      ref: 'main"; touch /tmp/pwned #',
    });

    expect(textFrom(result)).toContain("Invalid git ref");
    expect(fetch).not.toHaveBeenCalled();
    expect(executor.exec).not.toHaveBeenCalled();
  });

  it("passes repo, ref, and token through env in the Docker fallback", async () => {
    const executor = createExecutor();
    const tool = createGitCloneTool("ws_1", "http://ui.test", executor);

    const result = await tool.execute("call_1", {
      label: "clone safe ref",
      repo: "owner/repo",
      ref: "feature/safe-ref_1",
    });

    expect(textFrom(result)).toContain("Cloned owner/repo");
    const cloneCall = executor.exec.mock.calls.find(([command]) => command.includes("clone"));
    expect(cloneCall).toBeTruthy();

    const [cloneCommand, cloneOptions] = cloneCall!;
    expect(cloneCommand).toContain('"$GIT_URL"');
    expect(cloneCommand).toContain('"$GIT_DEST"');
    expect(cloneCommand).toContain('"$GIT_REF"');
    expect(cloneCommand).not.toContain("feature/safe-ref_1");
    expect(cloneCommand).not.toContain("ghs_secret_token");
    expect(cloneOptions?.env).toMatchObject({
      GIT_ASKPASS: "/tmp/git-askpass.sh",
      GIT_TERMINAL_PROMPT: "0",
      GIT_USERNAME: "x-access-token",
      GIT_PASSWORD: "ghs_secret_token",
      GIT_URL: "https://github.com/owner/repo.git",
      GIT_DEST: "/workspace/repos/owner_repo",
      GIT_REF: "feature/safe-ref_1",
    });
  });

  it("uses checkout for commit-like refs without interpolating the SHA", async () => {
    const executor = createExecutor();
    const tool = createGitCloneTool("ws_1", "http://ui.test", executor);

    await tool.execute("call_1", {
      label: "clone commit",
      repo: "owner/repo",
      ref: "29b242d",
    });

    const cloneCall = executor.exec.mock.calls.find(([command]) => command.includes("clone"));
    const [cloneCommand, cloneOptions] = cloneCall!;
    expect(cloneCommand).toContain('checkout "$GIT_REF"');
    expect(cloneCommand).not.toContain("29b242d");
    expect(cloneOptions?.env?.GIT_REF).toBe("29b242d");
  });
});
