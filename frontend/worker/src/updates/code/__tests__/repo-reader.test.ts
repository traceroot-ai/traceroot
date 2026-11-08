import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { windowsAt } from "@traceroot/core/updates";
import { buildOversizeRepo, buildSeededRepo, planCommits } from "../../dev/seed/commits.js";
import { startSlowRemote } from "../../dev/seed/slow-remote.js";
import { defaultParams, scheduleOf } from "../../dev/seed/scenario.js";
import { LocalShellSandboxProvider } from "../local-sandbox.js";
import { readRepo, type RepoReadOutcome } from "../repo-reader.js";

const run = promisify(execFile);
const windows = windowsAt(scheduleOf(defaultParams()), defaultParams().now);
const commits = planCommits(windows);
const SINCE = windows.prevWindowStart.toISOString();
const TOKEN = "stub-token-for-tests-0123456789";

let dir: string;
let app: { barePath: string; shas: Record<string, string> };
let big: { barePath: string };
let layout: { work: string; tmp: string };

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "repo-reader-test-"));
  app = await buildSeededRepo(dir, commits);
  big = await buildOversizeRepo(
    dir,
    3 * 1024 * 1024,
    commits.find((c) => c.key === "bad")!.at,
    commits[0].at,
  );
  layout = { work: path.join(dir, "box-work"), tmp: path.join(dir, "box-tmp") };
  await mkdir(layout.work, { recursive: true });
  await mkdir(layout.tmp, { recursive: true });
}, 60_000);
afterAll(() => rm(dir, { recursive: true, force: true }));

const read = async (overrides: Partial<Parameters<typeof readRepo>[0]> = {}) => {
  const provider = new LocalShellSandboxProvider();
  await rm(path.join(layout.work, "repo"), { recursive: true, force: true });
  const outcome = await readRepo({
    provider,
    cloneUrl: `file://${app.barePath}`,
    token: TOKEN,
    sinceIso: SINCE,
    changedPaths: ["src/research/planner.py"],
    layout,
    ...overrides,
  });
  return { provider, outcome };
};
const reader = (o: RepoReadOutcome) => {
  if (!o.ok) throw new Error(`expected a reader: ${o.reason}: ${o.detail}`);
  return o.reader;
};

describe("readRepo", () => {
  it("clones bounded, copies to a second sandbox and destroys both", async () => {
    const { provider, outcome } = await read();
    const r = reader(outcome);
    expect(provider.created.map((c) => c.networkAccess)).toEqual([true, false]);
    // The clone sandbox is already gone; the analysis one lives until closed.
    expect(await provider.listLive()).toEqual([r.sandboxId]);
    await r.close();
    expect(await provider.listLive()).toEqual([]);
  }, 60_000);

  it("reads the window's commits and the paths each touched, without file contents", async () => {
    const { outcome } = await read();
    const r = reader(outcome);
    const log = await r.commitsSince(SINCE);
    const bad = log.find((c) => c.sha === app.shas.bad)!;
    expect(bad.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(["src/research/planner.py", "src/research/refund.py"]),
    );
    expect(log.map((c) => c.sha)).toContain(app.shas.ctl);
    await r.close();
  }, 60_000);

  it("reads a changed file, and refuses a path that is not safe", async () => {
    const { outcome } = await read();
    const r = reader(outcome);
    expect(await r.readFile("src/research/planner.py")).toContain("def plan");
    await expect(r.readFile("../../etc/passwd")).rejects.toThrow(/not allowed/);
    await expect(r.readFile("-rf")).rejects.toThrow(/not allowed/);
    await expect(r.readFile("no/such/file.txt")).rejects.toThrow(/not in the read-only copy/);
    await r.close();
  }, 60_000);

  it("never gives the analysis sandbox the token", async () => {
    const { outcome } = await read();
    const r = reader(outcome);
    const iso = await r.verifyIsolation();
    expect(iso.tokenInEnvironment).toBe(false);
    expect(iso.tokenOnDisk).toBe(false);
    await r.close();
  }, 60_000);

  it("falls back, and destroys the sandbox, when the repository cannot be reached", async () => {
    const { provider, outcome } = await read({ cloneUrl: "http://127.0.0.1:9/seed-org/none.git" });
    expect(outcome).toMatchObject({ ok: false, reason: "unreachable" });
    expect(await provider.listLive()).toEqual([]);
    expect(provider.created.map((c) => c.networkAccess)).toEqual([true]);
  }, 60_000);

  it("falls back when the clone runs out of time", async () => {
    const remote = await startSlowRemote({ root: dir, delayMs: 2500, port: 18597 });
    try {
      const started = Date.now();
      const { provider, outcome } = await read({
        cloneUrl: `${remote.url}/seed-org/seed-app.git`,
        limits: { cloneTimeoutSec: 2, maxRepoBytes: 25e6, maxArchiveBytes: 30e6 },
      });
      expect(outcome).toMatchObject({ ok: false, reason: "timeout" });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(await provider.listLive()).toEqual([]);
    } finally {
      await remote.close();
    }
  }, 60_000);

  it("falls back when the repository is over the size limit after the clone", async () => {
    const { provider, outcome } = await read({
      limits: { cloneTimeoutSec: 60, maxRepoBytes: 1000, maxArchiveBytes: 30e6 },
    });
    expect(outcome).toMatchObject({ ok: false, reason: "oversize" });
    expect(await provider.listLive()).toEqual([]);
  }, 60_000);

  it("falls back when the files the window changed push it over the limit", async () => {
    const { provider, outcome } = await read({
      cloneUrl: `file://${big.barePath}`,
      changedPaths: ["payload.bin"],
      limits: { cloneTimeoutSec: 60, maxRepoBytes: 1024 * 1024, maxArchiveBytes: 30e6 },
    });
    expect(outcome).toMatchObject({ ok: false, reason: "oversize" });
    expect(await provider.listLive()).toEqual([]);
  }, 60_000);

  it("takes the tip alone when nothing was committed since the previous window began", async () => {
    const { outcome } = await read({ sinceIso: "2030-01-01T00:00:00Z" });
    const r = reader(outcome);
    expect(r).toBeDefined();
    await r.close();
  }, 60_000);

  it("does not let a hostile url or path reach a shell", async () => {
    const marker = path.join(dir, "pwned");
    const hostileUrl = `file://${app.barePath}"; touch "${marker}"; echo "`;
    const { outcome } = await read({
      cloneUrl: hostileUrl,
      changedPaths: [
        `a"; touch "${marker}"; "`,
        "$(touch " + marker + ")",
        "-x",
        "../../etc/passwd",
      ],
    });
    expect(outcome.ok).toBe(false);
    expect(existsSync(marker)).toBe(false);
    // Only the safe path is kept: the others never reach a command.
    const ok = await read({
      changedPaths: [`a"; touch "${marker}"; "`, "src/research/planner.py", "../../etc/passwd"],
    });
    await reader(ok.outcome).close();
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  it("keeps the token out of a failure message", async () => {
    const { outcome } = await read({ cloneUrl: `http://127.0.0.1:9/${TOKEN}/x.git` });
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  }, 60_000);
});
