import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerExecutor } from "../docker.js";

const execFileAsync = promisify(execFile);

// Opt in with RUN_DOCKER_TESTS=1 after pulling ubuntu:24.04. No packages,
// credentials or network access are needed inside the fixture container.
describe.skipIf(process.env.RUN_DOCKER_TESTS !== "1")("Docker command lifecycle (live)", () => {
  let containerId: string;
  let executor: DockerExecutor;

  async function docker(...args: string[]) {
    return (await execFileAsync("docker", args)).stdout.trim();
  }

  beforeAll(async () => {
    containerId = await docker(
      "run",
      "-d",
      "--name",
      `traceroot-exec-test-${randomUUID()}`,
      "--network",
      "none",
      "ubuntu:24.04",
      "sleep",
      "infinity",
    );
    executor = new DockerExecutor();
    // Exercise the real exec implementation without init's apt provisioning.
    Object.assign(executor, { containerId });
  });

  afterAll(async () => {
    if (containerId) await docker("rm", "-f", "-v", containerId);
  });

  async function markerExists(path: string) {
    return docker("exec", containerId, "sh", "-c", `test -e ${path} && echo yes || echo no`);
  }

  async function expectNoCommandState() {
    expect(
      await docker(
        "exec",
        containerId,
        "sh",
        "-c",
        "find /tmp -maxdepth 1 -name 'traceroot-exec-*' -print",
      ),
    ).toBe("");
  }

  it("stops a timed-out command and its child before either can write later", async () => {
    const result = await executor.exec(
      "sh -c 'sleep 1; touch /tmp/timeout-child' & sleep 1; touch /tmp/timeout-parent; wait",
      { timeout: 0.1 },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toBe("Command timed out after 0.1s");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await markerExists("/tmp/timeout-child")).toBe("no");
    expect(await markerExists("/tmp/timeout-parent")).toBe("no");
    expect(await executor.exec("printf usable")).toEqual({ stdout: "usable", stderr: "", code: 0 });
    await expectNoCommandState();
  });

  it.each(["timeout", "abort"])(
    "keeps a background child's group cancellable after the command shell exits (%s)",
    async (mode) => {
      const controller = new AbortController();
      const marker = `/tmp/background-after-${mode}`;
      const result = executor.exec(
        `sh -c 'sleep 1; touch ${marker}' &`,
        mode === "timeout" ? { timeout: 0.1 } : { signal: controller.signal },
      );
      const timer = mode === "abort" ? setTimeout(() => controller.abort(), 100) : undefined;
      try {
        expect((await result).code).not.toBe(0);
      } finally {
        clearTimeout(timer);
      }
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(await markerExists(marker)).toBe("no");
      await expectNoCommandState();
    },
  );

  it("cleans up after a normally completed background child and preserves output", async () => {
    expect(await executor.exec("sh -c 'sleep 0.2; printf child-output' &")).toEqual({
      stdout: "child-output",
      stderr: "",
      code: 0,
    });
    await expectNoCommandState();
  });

  it("aborts one command without stopping another command in the same sandbox", async () => {
    const controller = new AbortController();
    const unrelated = executor.exec("sleep 0.5; printf kept > /tmp/unrelated; printf kept");
    const canceled = executor.exec("sleep 1; touch /tmp/aborted", { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      expect(await canceled).toMatchObject({ code: 1, stderr: "Command aborted" });
      expect(await unrelated).toEqual({ stdout: "kept", stderr: "", code: 0 });
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await markerExists("/tmp/aborted")).toBe("no");
    expect(await markerExists("/tmp/unrelated")).toBe("yes");
    await expectNoCommandState();
  });

  it("honors cancellation that reaches the container before its launcher starts", async () => {
    // Delay setsid, before the production wrapper can publish its PID. The
    // separate cancellation exec must leave a marker the launcher observes.
    await docker(
      "exec",
      containerId,
      "sh",
      "-c",
      'printf \'#!/bin/sh\nsleep 0.7\nfor dir in /tmp/traceroot-exec-*; do [ ! -e "$dir/cancelled" ] || touch /tmp/cancel-before-launch; done\nexec /usr/bin/setsid "$@"\n\' > /usr/local/bin/setsid; chmod +x /usr/local/bin/setsid',
    );
    const controller = new AbortController();
    const result = executor.exec("touch /tmp/started-after-abort", {
      signal: controller.signal,
    });
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      expect(await result).toMatchObject({ code: 1, stderr: "Command aborted" });
    } finally {
      clearTimeout(timer);
      await docker("exec", containerId, "rm", "/usr/local/bin/setsid");
    }
    expect(await markerExists("/tmp/started-after-abort")).toBe("no");
    expect(await markerExists("/tmp/cancel-before-launch")).toBe("yes");
    await expectNoCommandState();
  });

  it("preserves shell quoting, environment values, output and nonzero exit codes", async () => {
    expect(
      await executor.exec("printf '%s' \"$VALUE\"; printf warning >&2; exit 7", {
        env: { VALUE: "spaces ' quotes $literal\nsecond line" },
      }),
    ).toEqual({ stdout: "spaces ' quotes $literal\nsecond line", stderr: "warning", code: 7 });
    await expectNoCommandState();
  });

  it("returns while a delayed launcher is still pending and leaves cancellation for it", async () => {
    await docker(
      "exec",
      containerId,
      "sh",
      "-c",
      'printf \'#!/bin/sh\nsleep 2.5\ntouch /tmp/fallback-launcher-resumed\nfor dir in /tmp/traceroot-exec-*; do [ ! -e "$dir/cancelled" ] || touch /tmp/fallback-marker-seen; done\nexec /usr/bin/setsid "$@"\n\' > /usr/local/bin/setsid; chmod +x /usr/local/bin/setsid',
    );
    const controller = new AbortController();
    const start = Date.now();
    const result = executor.exec("touch /tmp/fallback-command-started", {
      signal: controller.signal,
    });
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      expect(await result).toMatchObject({ code: 1, stderr: "Command aborted" });
      expect(await markerExists("/tmp/fallback-launcher-resumed")).toBe("no");
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 2800 - (Date.now() - start))));
      expect(await markerExists("/tmp/fallback-launcher-resumed")).toBe("yes");
      expect(await markerExists("/tmp/fallback-marker-seen")).toBe("yes");
      expect(await markerExists("/tmp/fallback-command-started")).toBe("no");
      await expectNoCommandState();
    } finally {
      clearTimeout(timer);
      await docker("exec", containerId, "rm", "/usr/local/bin/setsid");
    }
  });
});
