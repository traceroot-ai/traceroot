import type { Executor } from "./interface.js";
import { DockerExecutor } from "./docker.js";
import { DaytonaExecutor } from "./daytona.js";

export type { Executor, ExecResult, ExecOptions } from "./interface.js";

export function createExecutor(sessionId?: string): Executor {
  const provider = process.env.SANDBOX_PROVIDER || "docker";

  switch (provider) {
    case "docker":
      // The session id becomes the container's `traceroot.session` label so a
      // later process can tell an orphan from a live sandbox. Daytona is
      // platform-reclaimed (`ephemeral`, `autoStopInterval`) and takes no id.
      return new DockerExecutor(sessionId === undefined ? undefined : { sessionId });
    case "daytona":
      return new DaytonaExecutor();
    default:
      throw new Error(`Unknown sandbox provider: ${provider}`);
  }
}
