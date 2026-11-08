import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { windowsAt } from "@traceroot/core/updates";
import {
  buildGithubFixtures,
  buildOversizeRepo,
  buildSeededRepo,
  planCommits,
} from "../commits.js";
import { defaultParams, scheduleOf } from "../scenario.js";
import { startSlowRemote } from "../slow-remote.js";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  run("git", args, { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME } }).then((r) =>
    r.stdout.trim(),
  );

const windows = windowsAt(scheduleOf(defaultParams()), defaultParams().now);
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "update-seed-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("seeded repository", () => {
  it("builds the same commits with the same shas every time (S1)", async () => {
    const commits = planCommits(windows);
    await run("mkdir", ["-p", path.join(dir, "a")]);
    const a = await buildSeededRepo(path.join(dir, "a"), commits);
    await run("mkdir", ["-p", path.join(dir, "b")]);
    const b = await buildSeededRepo(path.join(dir, "b"), commits);
    expect(b.shas).toEqual(a.shas);
  });

  it("places each commit at its planned time, with tags", async () => {
    await run("mkdir", ["-p", path.join(dir, "c")]);
    const commits = planCommits(windows);
    const repo = await buildSeededRepo(path.join(dir, "c"), commits);
    for (const commit of commits) {
      const stamp = await git(repo.barePath, "show", "-s", "--format=%ct", repo.shas[commit.key]);
      expect(Number(stamp) * 1000).toBe(commit.at.getTime());
    }
    expect(await git(repo.barePath, "tag", "--list")).toBe("v1.3.0\nv1.4.0");
  });

  it("serves a blobless clone limited to the history since a date", async () => {
    await run("mkdir", ["-p", path.join(dir, "d")]);
    const commits = planCommits(windows);
    const repo = await buildSeededRepo(path.join(dir, "d"), commits);
    const target = path.join(dir, "d-clone");
    const since = windows.prevWindowStart.toISOString();
    await run("git", [
      "clone",
      "-q",
      "--filter=blob:none",
      "--no-checkout",
      `--shallow-since=${since}`,
      `file://${repo.barePath}`,
      target,
    ]);
    expect(await git(target, "config", "remote.origin.promisor")).toBe("true");
    const count = Number(await git(target, "rev-list", "--count", "HEAD"));
    expect(count).toBeGreaterThanOrEqual(commits.length - 1);
    expect(count).toBeLessThanOrEqual(commits.length);
  });

  it("aligns the GitHub fixtures with the commit shas", async () => {
    const commits = planCommits(windows);
    const shas = Object.fromEntries(commits.map((c) => [c.key, `sha-${c.key}`]));
    const fixtures = buildGithubFixtures(commits, shas).repos["seed-org/seed-app"];
    expect(fixtures.pulls.map((p) => p.number)).toEqual([99, 103, 101, 102]);
    expect(fixtures.pulls.find((p) => p.number === 101)!.mergeCommitSha).toBe("sha-bad");
    expect(fixtures.releases.map((r) => r.tag)).toEqual(["v1.3.0", "v1.4.0"]);
    expect(fixtures.pulls.find((p) => p.number === 103)!.title).toContain("PWNED-INJECTION-5521");
  });
});

describe("oversize repository", () => {
  it("has a payload of the requested size that does not compress away", async () => {
    await run("mkdir", ["-p", path.join(dir, "e")]);
    const big = await buildOversizeRepo(path.join(dir, "e"), 2 * 1024 * 1024, windows.windowStart);
    const counts = await git(big.barePath, "count-objects", "-v");
    const kib = (name: string) =>
      Number(counts.match(new RegExp(`^${name}: (\\d+)`, "m"))?.[1] ?? 0);
    expect((kib("size") + kib("size-pack")) / 1024).toBeGreaterThan(1.9);
  });
});

describe("slow remote", () => {
  it("serves a real clone, but only after the delay", async () => {
    await run("mkdir", ["-p", path.join(dir, "f")]);
    await buildSeededRepo(path.join(dir, "f"), planCommits(windows));
    const remote = await startSlowRemote({ root: path.join(dir, "f"), delayMs: 600, port: 18599 });
    try {
      const started = Date.now();
      await run("git", ["clone", "-q", `${remote.url}/seed-app.git`, path.join(dir, "f-clone")]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(600);
      expect(await readFile(path.join(dir, "f-clone", "VERSION"), "utf8")).toBe("1.4.0\n");
    } finally {
      await remote.close();
    }
  }, 30_000);

  it("fails fast against the unreachable address", async () => {
    await expect(
      run("git", ["ls-remote", "http://127.0.0.1:9/seed-org/seed-unreachable.git"], {
        timeout: 10_000,
      }),
    ).rejects.toThrow();
  });
});
