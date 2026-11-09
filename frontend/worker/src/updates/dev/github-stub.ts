import { promises as fs } from "node:fs";
import http from "node:http";
import type { GithubFixtures } from "./seed/commits.js";

/**
 * A stand-in for the slice of the GitHub REST API the code changes section
 * reads, served from the seeding script's fixtures. The answers have GitHub's
 * shapes, a private repository answers 404 to a request without the token, and
 * every request is recorded so a test can see what was asked.
 */

export interface GithubStub {
  url: string;
  token: string;
  /** Method and path of every request, in order. */
  requests: string[];
  close(): Promise<void>;
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

export function handleGithubRequest(
  fixtures: GithubFixtures,
  method: string,
  rawUrl: string,
  authorization: string | undefined,
): { status: number; body: unknown } {
  if (method !== "GET") return { status: 405, body: { message: "read-only" } };
  const url = new URL(rawUrl, "http://stub");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "repos" || parts.length < 3)
    return { status: 404, body: { message: "Not Found" } };
  const name = `${parts[1]}/${parts[2]}`;
  const repo = fixtures.repos[name];
  const authorized = authorization === `Bearer ${fixtures.token}`;
  if (!repo || (repo.private && !authorized))
    return { status: 404, body: { message: "Not Found" } };

  const rest = parts.slice(3);
  const page = Number(url.searchParams.get("page") ?? "1");
  const perPage = Math.min(100, Number(url.searchParams.get("per_page") ?? "30"));
  const slice = <T>(items: T[]) => items.slice((page - 1) * perPage, page * perPage);

  if (rest.length === 0) {
    return {
      status: 200,
      body: {
        full_name: name,
        default_branch: repo.defaultBranch,
        clone_url: repo.cloneUrl,
        size: repo.sizeKb,
        private: repo.private,
      },
    };
  }
  if (rest[0] === "pulls" && rest.length === 1) {
    return {
      status: 200,
      body: slice(
        [...repo.pulls].reverse().map((p) => ({
          number: p.number,
          title: p.title,
          state: "closed",
          merged_at: p.mergedAt,
          merge_commit_sha: p.mergeCommitSha,
          user: { login: p.author },
          html_url: p.url,
        })),
      ),
    };
  }
  if (rest[0] === "pulls" && rest[2] === "files") {
    const pull = repo.pulls.find((p) => String(p.number) === rest[1]);
    if (!pull) return { status: 404, body: { message: "Not Found" } };
    return {
      status: 200,
      body: slice(pull.files.map((filename) => ({ filename, status: "modified" }))),
    };
  }
  if (rest[0] === "releases") {
    return {
      status: 200,
      body: slice(
        repo.releases.map((r) => ({
          tag_name: r.tag,
          name: r.name,
          published_at: r.publishedAt,
          html_url: r.url,
        })),
      ),
    };
  }
  if (rest[0] === "commits" && rest[1]) {
    const ref = rest[1];
    const tag = repo.tags.find((t) => t.name === ref);
    const pull = repo.pulls.find((p) => p.mergeCommitSha === ref);
    const sha = tag?.commitSha ?? pull?.mergeCommitSha ?? (/^[0-9a-f]{40}$/.test(ref) ? ref : null);
    return sha ? { status: 200, body: { sha } } : { status: 404, body: { message: "Not Found" } };
  }
  return { status: 404, body: { message: "Not Found" } };
}

export async function startGithubStub(options: {
  fixturesPath: string;
  port: number;
}): Promise<GithubStub> {
  const fixtures = JSON.parse(await fs.readFile(options.fixturesPath, "utf8")) as GithubFixtures;
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const { status, body } = handleGithubRequest(
      fixtures,
      req.method ?? "GET",
      req.url ?? "/",
      req.headers.authorization,
    );
    json(res, status, body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${options.port}`,
        token: fixtures.token,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
