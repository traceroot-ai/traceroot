import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubCommitsTool,
  createGitHubPullTool,
  createGitHubPullsTool,
} from "../github-read.js";

const TOKEN = "ghs_supersecrettoken000000000000000000";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Routes the token request to the UI stub and everything else to `github`. */
function stubFetch(github: Handler, tokenStatus = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith("http://ui.test/api/github/token")) {
        return new Response(JSON.stringify({ token: TOKEN }), { status: tokenStatus });
      }
      return github(url, init);
    }),
  );
  return calls;
}

const out = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("\n");

afterEach(() => vi.unstubAllGlobals());

describe("github_commits", () => {
  const tool = createGitHubCommitsTool("ws_1", "http://ui.test");

  it("lists commits with a bounded page size and sends the token only to the GitHub API", async () => {
    const calls = stubFetch(
      () =>
        new Response(
          JSON.stringify([
            {
              sha: "abcdef1234567",
              commit: { message: "fix thing\n\nlong body", author: { name: "Ann", date: "d" } },
            },
          ]),
        ),
    );
    const result = await tool.execute(
      {} as never,
      {
        repo: "acme/api",
        path: "src/a.ts",
        limit: 9999,
      } as never,
    );
    expect(out(result)).toContain("abcdef1 d Ann: fix thing");
    expect(out(result)).not.toContain("long body");
    const gh = calls.find((c) => c.url.startsWith("https://api.github.com/"))!;
    expect(gh.url).toContain("/repos/acme/api/commits");
    expect(gh.url).toContain("per_page=50");
    expect(gh.url).toContain("path=src%2Fa.ts");
    expect((gh.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("rejects a malformed repository before any request", async () => {
    const calls = stubFetch(() => new Response("[]"));
    const result = await tool.execute({} as never, { repo: "acme/api/../x" } as never);
    expect(out(result)).toContain("Invalid repository");
    expect(calls).toHaveLength(0);
  });

  it("rejects dot segments in the repository", async () => {
    const calls = stubFetch(() => new Response("[]"));
    const result = await tool.execute({} as never, { repo: "acme/.." } as never);
    expect(out(result)).toContain("Invalid repository");
    expect(calls).toHaveLength(0);
  });

  it("says so when no installation exists", async () => {
    stubFetch(() => new Response("[]"), 404);
    const result = await tool.execute({} as never, { repo: "acme/api" } as never);
    expect(out(result)).toContain("No GitHub App installed");
  });

  it("never returns the token, even when the API echoes it", async () => {
    stubFetch(() => new Response(`bad credentials ${TOKEN}`, { status: 403 }));
    const result = await tool.execute({} as never, { repo: "acme/api" } as never);
    expect(out(result)).toContain("GitHub API error 403");
    expect(out(result)).not.toContain(TOKEN);
  });
});

describe("github_pulls", () => {
  const tool = createGitHubPullsTool("ws_1", "http://ui.test");

  it("marks merged pull requests", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify([
            {
              number: 7,
              title: "A",
              state: "closed",
              merged_at: "2026-01-01",
              user: { login: "u" },
            },
            { number: 6, title: "B", state: "closed", merged_at: null, user: { login: "u" } },
          ]),
        ),
    );
    const text = out(await tool.execute({} as never, { repo: "acme/api" } as never));
    expect(text).toContain("#7 [merged 2026-01-01]");
    expect(text).toContain("#6 [closed]");
  });
});

describe("github_pull", () => {
  const tool = createGitHubPullTool("ws_1", "http://ui.test");

  it("rejects a non-integer number before any request", async () => {
    const calls = stubFetch(() => new Response("{}"));
    const result = await tool.execute({} as never, { repo: "acme/api", number: 1.5 } as never);
    expect(out(result)).toContain("Invalid pull request number");
    expect(calls).toHaveLength(0);
  });

  it("truncates a large diff", async () => {
    const calls = stubFetch(() => new Response("+x\n".repeat(100_000)));
    const text = out(
      await tool.execute({} as never, { repo: "acme/api", number: 3, diff: true } as never),
    );
    expect(text.length).toBeLessThan(60 * 1024);
    const gh = calls.find((c) => c.url.startsWith("https://api.github.com/"))!;
    expect((gh.init?.headers as Record<string, string>).Accept).toBe("application/vnd.github.diff");
  });
});
