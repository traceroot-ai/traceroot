import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { windowsAt } from "@traceroot/core/updates";
import { buildSeededRepo, planCommits } from "../../dev/seed/commits.js";
import { startSlowRemote } from "../../dev/seed/slow-remote.js";
import { defaultParams, scheduleOf } from "../../dev/seed/scenario.js";
import { readRepo } from "../repo-reader.js";
import {
  DaytonaSandboxProvider,
  DockerSandboxProvider,
  type DaytonaLike,
  type DaytonaSandboxLike,
} from "../sandbox.js";

const dockerReady = (() => {
  try {
    execFileSync("docker", ["image", "inspect", "alpine/git:latest"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("DaytonaSandboxProvider (against a fake SDK; the real service is not reachable with the stored key)", () => {
  function fake() {
    const created: Record<string, unknown>[] = [];
    const deleted: string[] = [];
    const sandbox = (n: number): DaytonaSandboxLike => ({
      id: `dt-${n}`,
      process: {
        executeCommand: vi.fn(
          async (command: string, _cwd?: string, env?: Record<string, string>) => ({
            exitCode: command.includes("fail") ? 3 : 0,
            result: `ran ${command} with ${Object.keys(env ?? {}).join(",")}`,
          }),
        ),
      },
      fs: {
        uploadFile: vi.fn(async () => undefined),
        downloadFile: vi.fn(async () => Buffer.from("tar")),
      },
      delete: vi.fn(async () => {
        deleted.push(`dt-${n}`);
      }),
    });
    let n = 0;
    const live = new Set<string>();
    const daytona: DaytonaLike = {
      create: vi.fn(async (params) => {
        created.push(params);
        const s = sandbox((n += 1));
        live.add(s.id);
        const del = s.delete;
        s.delete = async () => {
          live.delete(s.id);
          await del();
        };
        return s;
      }),
      list: vi.fn(async () => ({ items: [...live].map((id) => ({ id })) })),
    };
    return { daytona, created, deleted };
  }

  it("blocks the network from the start for the analysis sandbox, and only then", async () => {
    const { daytona, created } = fake();
    const provider = new DaytonaSandboxProvider(daytona);
    await provider.create({ networkAccess: true });
    await provider.create({ networkAccess: false });
    expect(created.map((c) => c.networkBlockAll)).toEqual([false, true]);
    expect(created.every((c) => c.ephemeral === true)).toBe(true);
  });

  it("hands values to commands through the environment and reports failures", async () => {
    const { daytona } = fake();
    const box = await new DaytonaSandboxProvider(daytona).create({ networkAccess: true });
    const ok = await box.exec('git clone "$GIT_URL"', { env: { GIT_URL: "x" } });
    expect(ok).toMatchObject({ code: 0, timedOut: false });
    expect(ok.stdout).toContain("with GIT_URL");
    expect((await box.exec("fail now")).code).toBe(3);
  });

  it("lists what is still alive and destroys on request", async () => {
    const { daytona, deleted } = fake();
    const provider = new DaytonaSandboxProvider(daytona);
    const a = await provider.create({ networkAccess: true });
    expect(await provider.listLive()).toEqual([a.id]);
    await a.destroy();
    expect(deleted).toEqual([a.id]);
    expect(await provider.listLive()).toEqual([]);
  });
});

describe.skipIf(!dockerReady)("DockerSandboxProvider (real containers)", () => {
  const windows = windowsAt(scheduleOf(defaultParams()), defaultParams().now);
  let dir: string;
  let shas: Record<string, string>;
  let remote: Awaited<ReturnType<typeof startSlowRemote>>;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "docker-sandbox-test-"));
    shas = (await buildSeededRepo(dir, planCommits(windows))).shas;
    remote = await startSlowRemote({ root: dir, delayMs: 0, port: 18596 });
  }, 60_000);
  afterAll(async () => {
    await remote.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("clones over the network, then reads in a container that has none and no token", async () => {
    const provider = new DockerSandboxProvider({ cloneNetwork: "host", limits: {} });
    const before = await provider.listLive();
    const outcome = await readRepo({
      provider,
      cloneUrl: `${remote.url}/seed-org/seed-app.git`,
      token: "docker-test-token-98765",
      sinceIso: windows.prevWindowStart.toISOString(),
      changedPaths: ["src/research/planner.py"],
    });
    if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.detail}`);
    const reader = outcome.reader;
    try {
      const log = await reader.commitsSince(windows.prevWindowStart.toISOString());
      expect(log.map((c) => c.sha)).toContain(shas.bad);
      expect(await reader.readFile("src/research/planner.py")).toContain("def plan");
      // The container is created without network, and the clone container is already gone.
      expect((await provider.listLive()).filter((id) => !before.includes(id))).toEqual([
        reader.sandboxId,
      ]);
      expect(await reader.verifyIsolation()).toEqual({
        egressBlocked: true,
        tokenInEnvironment: false,
        tokenOnDisk: false,
      });
    } finally {
      await reader.close();
    }
    expect((await provider.listLive()).filter((id) => !before.includes(id))).toEqual([]);
  }, 180_000);

  it("destroys the containers when the repository cannot be reached", async () => {
    const provider = new DockerSandboxProvider({ cloneNetwork: "host", limits: {} });
    const before = await provider.listLive();
    const outcome = await readRepo({
      provider,
      cloneUrl: "http://127.0.0.1:9/seed-org/none.git",
      token: "docker-test-token-98765",
      sinceIso: windows.prevWindowStart.toISOString(),
      changedPaths: [],
    });
    expect(outcome).toMatchObject({ ok: false, reason: "unreachable" });
    expect((await provider.listLive()).filter((id) => !before.includes(id))).toEqual([]);
  }, 120_000);
});
