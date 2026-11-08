import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { windowsAt, type WindowAggregates } from "@traceroot/core/updates";
import { handleGithubRequest } from "../../dev/github-stub.js";
import {
  buildGithubFixtures,
  buildSeededRepo,
  planCommits,
  type GithubFixtures,
} from "../../dev/seed/commits.js";
import { startSlowRemote } from "../../dev/seed/slow-remote.js";
import { defaultParams, scheduleOf } from "../../dev/seed/scenario.js";
import { gatherCodeChanges, type CodeChangesDeps } from "../code-changes.js";
import { codeChangesTools } from "../tools.js";
import { LocalShellSandboxProvider } from "../local-sandbox.js";

const windows = windowsAt(scheduleOf(defaultParams()), defaultParams().now);
const commits = planCommits(windows);
const window = {
  windowStart: windows.windowStart,
  windowEnd: windows.windowEnd,
  prevWindowStart: windows.prevWindowStart,
};
let dir: string;
let shas: Record<string, string>;
let bare: string;
let fixtures: GithubFixtures;

function aggregates(over: Partial<WindowAggregates> = {}): WindowAggregates {
  return {
    start: "a",
    end: "b",
    totals: { traces: 1000, errorTraces: 30, p50Ms: 1, p95Ms: 1, p99Ms: 1, gitContextTraces: 1000 },
    llm: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: "0" },
    byModel: [],
    byModelDay: [],
    tools: [],
    workflows: [],
    refs: [{ name: shas.bad, traces: 144, errorTraces: 32, p50Ms: 1, p95Ms: 1 }],
    repos: [{ name: "seed-org/seed-app", traces: 1000 }],
    sourceFiles: [],
    truncated: [],
    ...over,
  };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "code-changes-test-"));
  const built = await buildSeededRepo(dir, commits);
  shas = built.shas;
  bare = built.barePath;
  fixtures = buildGithubFixtures(commits, shas, {
    gitBase: `file://${dir}`,
    slowBase: "http://127.0.0.1:18595",
    deadUrl: "http://127.0.0.1:9/seed-org/seed-dead.git",
  });
}, 60_000);
afterAll(() => rm(dir, { recursive: true, force: true }));

let boxes = 0;

function deps(over: Partial<CodeChangesDeps> = {}, token = fixtures.token) {
  // The local sandbox stands in for a container: a fresh set of directories each time, as a fresh container has.
  const base = path.join(dir, "box", String((boxes += 1)));
  mkdirSync(path.join(base, "work"), { recursive: true });
  mkdirSync(path.join(base, "tmp"), { recursive: true });
  const provider = new LocalShellSandboxProvider();
  const requests: string[] = [];
  const built: CodeChangesDeps = {
    provider,
    github: {
      baseUrl: "http://stub",
      fetchImpl: async (url, init) => {
        const u = new URL(url);
        requests.push(u.pathname);
        const { status, body } = handleGithubRequest(
          fixtures,
          "GET",
          u.pathname + u.search,
          init.headers.Authorization,
        );
        return new Response(JSON.stringify(body), { status });
      },
    },
    tokenFor: vi.fn(async () => token),
    // The local stand-in isolates nothing, so it cannot pass the check; the Docker test does.
    verifyIsolation: false,
    layout: { work: path.join(base, "work"), tmp: path.join(base, "tmp") },
    ...over,
  };
  return { deps: built, provider, requests };
}

const ON = { enabled: true, repos: ["seed-org/seed-app"], workspaceId: "w1" };
const input = (over: Partial<WindowAggregates> = {}) => ({
  current: aggregates(over),
  previous: aggregates({ refs: [] }),
});

describe("gatherCodeChanges", () => {
  it("is off by default and touches nothing", async () => {
    const { deps: d, provider, requests } = deps();
    const out = await gatherCodeChanges(
      d,
      { enabled: false, repos: ["seed-org/seed-app"], workspaceId: "w1" },
      input(),
      window,
    );
    expect(out.report.status).toBe("off");
    expect(requests).toEqual([]);
    expect(provider.created).toEqual([]);
    expect(d.tokenFor).not.toHaveBeenCalled();
  });

  it("says there is no git context and reads nothing when the traces carry none", async () => {
    const { deps: d, requests } = deps();
    const none = input({
      repos: [],
      refs: [],
      totals: { ...aggregates().totals, gitContextTraces: 0 },
    });
    const out = await gatherCodeChanges(d, ON, none, window);
    expect(out.report.status).toBe("no_git_context");
    expect(out.report.notes.join(" ")).toContain("no git context");
    expect(requests).toEqual([]);
  });

  it("honours the allowlist: a repository that is not listed is not read", async () => {
    const { deps: d, requests, provider } = deps();
    const out = await gatherCodeChanges(
      d,
      { enabled: true, repos: ["someone/else"], workspaceId: "w1" },
      input(),
      window,
    );
    expect(out.report.status).toBe("not_allowed");
    expect(out.report.notes.join(" ")).toContain("not on this project's list");
    expect(d.tokenFor).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(provider.created).toEqual([]);
  });

  it("matches the allowlist without regard to case", async () => {
    const { deps: d } = deps({ cloneUrlFor: () => `file://${bare}` });
    const out = await gatherCodeChanges(
      d,
      { enabled: true, repos: ["Seed-Org/Seed-App"], workspaceId: "w1" },
      input(),
      window,
    );
    expect(out.report.status).toBe("ready");
    await out.close();
  }, 60_000);

  it("joins the planted merges to traffic by commit when the clone works, and leaves the control quiet", async () => {
    const ctlShift = input({
      refs: [
        { name: shas.bad, traces: 144, errorTraces: 32, p50Ms: 1, p95Ms: 1 },
        { name: shas.ctl, traces: 108, errorTraces: 3, p50Ms: 1, p95Ms: 1 },
      ],
    });
    const { deps: d } = deps({ cloneUrlFor: () => `file://${bare}` });
    const out = await gatherCodeChanges(d, ON, ctlShift, window);
    try {
      expect(out.report).toMatchObject({
        status: "ready",
        method: "ref_split",
        clone: { mode: "clone" },
      });
      const byLabel = Object.fromEntries(out.report.items.map((i) => [i.label, i]));
      expect(byLabel["PR #101"].evidence).toContain("32 of 144 failed");
      expect(byLabel["release v1.4.0"]).toMatchObject({
        kind: "release",
        sha: shas.release,
        traffic: null,
      });
      expect(byLabel["PR #102"].evidence).toBeNull();
      expect(out.report.commits.map((c) => c.sha)).toContain(shas.bad);
      // The changed files are readable, the injected notes file among them, and shown only as data.
      expect(out.report.excerpts.map((e) => e.path)).toEqual(
        expect.arrayContaining(["src/research/planner.py", "docs/NOTES.md"]),
      );
      expect(out.report.excerpts.find((e) => e.path === "docs/NOTES.md")!.lines).toContain(
        "PWNED-INJECTION-4410",
      );
      expect(out.allowedUrls).toEqual(
        expect.arrayContaining(["https://github.com/seed-org/seed-app/pull/101"]),
      );
    } finally {
      await out.close();
    }
  }, 60_000);

  it("will not use a sandbox that fails its isolation check", async () => {
    const { deps: d, provider } = deps({ verifyIsolation: true });
    // The local stand-in has the host's network, so egress is open and the check fails closed.
    const out = await gatherCodeChanges(d, ON, input(), window);
    expect(out.report.clone).toMatchObject({ mode: "api_only", fallbackReason: "failed" });
    expect(out.reader).toBeNull();
    expect(await provider.listLive()).toEqual([]);
  }, 60_000);

  it("exposes the two tools, the file reader only when the copy exists", async () => {
    const { deps: d } = deps({ cloneUrlFor: () => `file://${bare}` });
    const out = await gatherCodeChanges(d, ON, input(), window);
    try {
      const tools = codeChangesTools(out);
      expect(tools.map((t) => t.tool.name)).toEqual(["get_code_changes", "read_repo_file"]);
      expect(JSON.parse(await tools[0].run({})).status).toBe("ready");
      expect(await tools[1].run({ path: "src/research/planner.py" })).toContain("def plan");
    } finally {
      await out.close();
    }
    const apiOnly = await gatherCodeChanges(deps({ provider: null }).deps, ON, input(), window);
    expect(codeChangesTools(apiOnly).map((t) => t.tool.name)).toEqual(["get_code_changes"]);
  }, 60_000);

  it("destroys every sandbox when the run is closed", async () => {
    const { deps: d, provider } = deps({ cloneUrlFor: () => `file://${bare}` });
    const out = await gatherCodeChanges(d, ON, input(), window);
    expect(provider.created.map((c) => c.networkAccess)).toEqual([true, false]);
    expect((await provider.listLive()).length).toBe(1);
    await out.close();
    expect(await provider.listLive()).toEqual([]);
  }, 60_000);

  describe("falls back to the host's metadata, and says so", () => {
    it("when the repository cannot be reached", async () => {
      const { deps: d, provider } = deps({
        cloneUrlFor: () => "http://127.0.0.1:9/seed-org/seed-dead.git",
      });
      const out = await gatherCodeChanges(d, ON, input(), window);
      expect(out.report.clone).toMatchObject({ mode: "api_only", fallbackReason: "unreachable" });
      expect(out.report.clone.note).toBe(
        "Code diffs unavailable this period: the repository could not be reached; showing pull request and release metadata only.",
      );
      expect(out.report.items.map((i) => i.label)).toContain("PR #101");
      expect(await provider.listLive()).toEqual([]);
    }, 60_000);

    it("when the clone times out", async () => {
      const remote = await startSlowRemote({ root: dir, delayMs: 3000, port: 18595 });
      try {
        const { deps: d, provider } = deps({
          cloneUrlFor: () => `${remote.url}/seed-org/seed-app.git`,
          limits: { cloneTimeoutSec: 2, maxRepoBytes: 25e6, maxArchiveBytes: 30e6 },
        });
        const out = await gatherCodeChanges(d, ON, input(), window);
        expect(out.report.clone).toMatchObject({ mode: "api_only", fallbackReason: "timeout" });
        expect(out.report.clone.note).toContain("the clone timed out");
        expect(await provider.listLive()).toEqual([]);
      } finally {
        await remote.close();
      }
    }, 60_000);

    it("without cloning at all when the host reports the repository far over the size limit", async () => {
      const big: GithubFixtures = JSON.parse(JSON.stringify(fixtures));
      big.repos["seed-org/seed-app"].sizeKb = 2000 * 1024;
      const { deps: d, provider } = deps();
      const fixturesBefore = fixtures;
      fixtures = big;
      try {
        const out = await gatherCodeChanges(d, ON, input(), window);
        expect(out.report.clone).toMatchObject({ mode: "api_only", fallbackReason: "oversize" });
        expect(provider.created).toEqual([]);
      } finally {
        fixtures = fixturesBefore;
      }
    });

    it("when no sandbox is available", async () => {
      const out = await gatherCodeChanges(deps({ provider: null }).deps, ON, input(), window);
      expect(out.report.clone).toMatchObject({ mode: "api_only", fallbackReason: "not_attempted" });
      expect(out.report.status).toBe("ready");
    });
  });

  it("skips the section with a note when no token can be had", async () => {
    const { deps: d } = deps({
      tokenFor: async () => {
        throw new Error("no installation");
      },
    });
    const out = await gatherCodeChanges(d, ON, input(), window);
    expect(out.report.status).toBe("no_repository_data");
    expect(out.report.notes.join(" ")).toContain("No access token");
  });

  it("skips the section with a note when the host does not answer for the repository", async () => {
    const { deps: d } = deps({}, "wrong-token");
    const out = await gatherCodeChanges(d, ON, input(), window);
    expect(out.report.status).toBe("no_repository_data");
    expect(out.report.notes.join(" ")).toContain("did not answer");
  });
});
