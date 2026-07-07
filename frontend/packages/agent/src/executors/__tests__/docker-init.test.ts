import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecFile, mockExecFileAsync, mockSpawn } = vi.hoisted(() => {
  return {
    mockExecFile: vi.fn(),
    mockExecFileAsync: vi.fn(),
    mockSpawn: vi.fn(),
  };
});

vi.mock("child_process", () => ({
  spawn: mockSpawn,
  execFile: mockExecFile,
}));

vi.mock("util", () => ({
  promisify: () => mockExecFileAsync,
}));

import { DockerExecutor } from "../docker.js";

function mockDockerRun(containerId = "container-123") {
  mockExecFileAsync.mockResolvedValueOnce({ stdout: `${containerId}\n`, stderr: "" });
}

function mockDockerRm() {
  mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });
}

function mockDockerExecClose(code = 0, stderr = "") {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setTimeout(() => {
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  }, 0);
  mockSpawn.mockReturnValueOnce(child);
}

describe("DockerExecutor init()", () => {
  let executor: DockerExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new DockerExecutor();
  });

  it("fails init and resets readiness when required tool installation fails", async () => {
    mockDockerRun();
    mockDockerExecClose(); // mkdir
    mockDockerExecClose(100, "apt failed"); // install tools
    mockDockerRm();

    await expect(executor.init()).rejects.toThrow(
      "Failed to install required container tools: apt failed",
    );

    expect(executor.isReady()).toBe(false);
    expect(mockExecFileAsync).toHaveBeenLastCalledWith("docker", ["rm", "-f", "container-123"]);
  });
});
