import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerExecutor } from "../docker.js";

const execFileAsync = promisify(execFile);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs against a real Docker daemon, so it is opt-in: RUN_DOCKER_TESTS=1 with
// ubuntu:24.04 available locally. The fixture container has no network.
describe.skipIf(process.env.RUN_DOCKER_TESTS !== "1")("DockerExecutor.exec (live Docker)", () => {
  let containerId: string;
  let executor: DockerExecutor;

  async function docker(...args: string[]): Promise<string> {
    return (await execFileAsync("docker", args)).stdout.trim();
  }

  async function exists(path: string): Promise<boolean> {
    return (
      (await docker("exec", containerId, "sh", "-c", `test -e ${path} && echo y || :`)) === "y"
    );
  }

  /** Zombies and the tests' own `sleep N` processes left in the container. */
  async function strayProcesses(): Promise<string> {
    return docker(
      "exec",
      containerId,
      "sh",
      "-c",
      "ps -eo stat=,args= | grep -e '^Z' -e ' sleep [0-9]' || :",
    );
  }

  beforeAll(async () => {
    // The same `--init` sleeper init() starts, without its apt provisioning.
    containerId = await docker(
      "run",
      "-d",
      "--init",
      "--network",
      "none",
      "--name",
      `traceroot-exec-test-${randomUUID()}`,
      "ubuntu:24.04",
      "sleep",
      "infinity",
    );
    executor = new DockerExecutor();
    Object.assign(executor, { containerId });
  });

  afterAll(async () => {
    if (containerId) await docker("rm", "-f", "-v", containerId);
  });

  it("stops a timed-out command and everything it started before returning", async () => {
    const result = await executor.exec(
      // A child, a grandchild in a subshell, and one that leaves the session.
      "(sleep 1; touch /tmp/t-sub) & setsid sh -c 'sleep 1; touch /tmp/t-setsid' & sleep 1; touch /tmp/t-main",
      { timeout: 0.3 },
    );

    expect(result).toEqual({ stdout: "", stderr: "Command timed out after 0.3s", code: 1 });
    await sleep(1200);
    for (const marker of ["/tmp/t-sub", "/tmp/t-setsid", "/tmp/t-main"]) {
      expect(await exists(marker)).toBe(false);
    }
    await expect.poll(strayProcesses).toBe("");
  });

  it("stops an aborted command and reports it as a failure", async () => {
    const controller = new AbortController();
    const pending = executor.exec("echo started; sleep 1; touch /tmp/a-main", {
      signal: controller.signal,
    });
    await sleep(300);
    controller.abort();

    expect(await pending).toEqual({ stdout: "started\n", stderr: "Command aborted", code: 1 });
    await sleep(1200);
    expect(await exists("/tmp/a-main")).toBe(false);
    await expect.poll(strayProcesses).toBe("");
  });

  it("stops a background child that outlives the command's shell", async () => {
    // The shell exits at once, but the child keeps the output stream open.
    const result = await executor.exec("sh -c 'sleep 1; touch /tmp/b-child' &", { timeout: 0.3 });

    expect(result.code).toBe(1);
    await sleep(1200);
    expect(await exists("/tmp/b-child")).toBe(false);
  });

  it("leaves a detached background process running when the command returns", async () => {
    // e.g. starting a dev server: the command finishes, the server keeps going.
    expect(await executor.exec("sleep 1 >/dev/null 2>&1 & echo started")).toEqual({
      stdout: "started\n",
      stderr: "",
      code: 0,
    });
    expect(await strayProcesses()).toContain("sleep 1");
    // It is left to finish on its own, and init reaps it when it does.
    await expect.poll(strayProcesses, { timeout: 3000 }).toBe("");
  });

  it("aborts one command without touching another running beside it", async () => {
    const controller = new AbortController();
    const other = executor.exec("sleep 0.6; touch /tmp/c-other; printf kept");
    const aborted = executor.exec("sleep 1; touch /tmp/c-aborted", { signal: controller.signal });
    await sleep(300);
    controller.abort();

    expect(await aborted).toMatchObject({ stderr: "Command aborted", code: 1 });
    expect(await other).toEqual({ stdout: "kept", stderr: "", code: 0 });
    await sleep(1000);
    expect(await exists("/tmp/c-other")).toBe(true);
    expect(await exists("/tmp/c-aborted")).toBe(false);
  });

  it("keeps the sandbox usable, with quoting, env, stderr and exit codes intact", async () => {
    await executor.exec("sleep 5", { timeout: 0.2 });

    expect(
      await executor.exec(`printf '%s' "$VALUE"; printf warn >&2; exit 7`, {
        env: { VALUE: "it's $HOME\nsecond line" },
      }),
    ).toEqual({ stdout: "it's $HOME\nsecond line", stderr: "warn", code: 7 });
    expect(await docker("exec", containerId, "sh", "-c", "ls /tmp | grep -c traceroot || :")).toBe(
      "0",
    );
  });
});
