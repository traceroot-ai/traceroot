import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: mockSpawn,
  execFile: vi.fn(),
}));

import { DockerExecutor } from "../docker.js";

function mockDockerExecClose(code = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => child.emit("close", code));
  mockSpawn.mockReturnValueOnce(child);
}

describe("DockerExecutor", () => {
  let executor: DockerExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new DockerExecutor();
    (executor as unknown as { containerId: string }).containerId = "container-123";
  });

  describe("exec()", () => {
    it("passes ExecOptions.env through docker exec -e args", async () => {
      mockDockerExecClose();

      await executor.exec("printenv SECRET_TOKEN", {
        env: {
          SECRET_TOKEN: "token with spaces",
          GIT_TERMINAL_PROMPT: "0",
        },
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        "docker",
        [
          "exec",
          "-e",
          "SECRET_TOKEN=token with spaces",
          "-e",
          "GIT_TERMINAL_PROMPT=0",
          "container-123",
          "sh",
          "-c",
          "printenv SECRET_TOKEN",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    });
  });
});
