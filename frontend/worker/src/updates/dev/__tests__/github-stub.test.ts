import { describe, expect, it } from "vitest";
import { windowsAt } from "@traceroot/core/updates";
import { buildGithubFixtures, planCommits } from "../seed/commits.js";
import { defaultParams, scheduleOf } from "../seed/scenario.js";
import { handleGithubRequest } from "../github-stub.js";
import {
  fetchMergedPulls,
  fetchReleases,
  fetchRepoInfo,
  GithubApiError,
} from "../../code/github-api.js";

const windows = windowsAt(scheduleOf(defaultParams()), defaultParams().now);
const commits = planCommits(windows);
const shas = Object.fromEntries(commits.map((c) => [c.key, `${c.key}`.padEnd(40, "0")]));
const fixtures = buildGithubFixtures(commits, shas);
const TOKEN = fixtures.token;

/** The real client against the stand-in's handler, no sockets. */
const config = (token = TOKEN) => ({
  baseUrl: "http://stub",
  token,
  fetchImpl: async (url: string, init: { headers: Record<string, string> }) => {
    const u = new URL(url);
    const { status, body } = handleGithubRequest(
      fixtures,
      "GET",
      u.pathname + u.search,
      init.headers.Authorization,
    );
    return new Response(JSON.stringify(body), { status });
  },
});

describe("the GitHub stand-in and the client that reads it", () => {
  it("answers the repository record, with the clone url and the size", async () => {
    const info = await fetchRepoInfo(config(), "seed-org/seed-app");
    expect(info).toMatchObject({
      fullName: "seed-org/seed-app",
      defaultBranch: "main",
      sizeKb: 120,
    });
  });

  it("lists the pull requests merged in the window with their changed paths, oldest first", async () => {
    const pulls = await fetchMergedPulls(
      config(),
      "seed-org/seed-app",
      windows.windowStart,
      windows.windowEnd,
    );
    expect(pulls.map((p) => p.number)).toEqual([103, 101, 102]);
    expect(pulls.find((p) => p.number === 101)!.files).toContain("src/research/planner.py");
    expect(pulls.find((p) => p.number === 101)!.mergeCommitSha).toBe(shas.bad);
  });

  it("leaves out a pull request merged before the window", async () => {
    const pulls = await fetchMergedPulls(
      config(),
      "seed-org/seed-app",
      windows.windowStart,
      windows.windowEnd,
    );
    expect(pulls.map((p) => p.number)).not.toContain(99);
  });

  it("lists releases in the window with the commit their tag points at", async () => {
    const releases = await fetchReleases(
      config(),
      "seed-org/seed-app",
      windows.windowStart,
      windows.windowEnd,
    );
    expect(releases).toEqual([expect.objectContaining({ tag: "v1.4.0", commitSha: shas.release })]);
  });

  it("answers a private repository only to the token", async () => {
    await expect(fetchRepoInfo(config("wrong"), "seed-org/seed-app")).rejects.toBeInstanceOf(
      GithubApiError,
    );
    await expect(fetchRepoInfo(config(), "seed-org/unknown")).rejects.toThrow(/404/);
  });

  it("refuses anything but a read", () => {
    expect(
      handleGithubRequest(fixtures, "POST", "/repos/seed-org/seed-app/pulls", `Bearer ${TOKEN}`)
        .status,
    ).toBe(405);
  });
});
