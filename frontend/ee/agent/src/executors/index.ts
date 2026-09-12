import type { Executor } from "./interface.js";
import { DockerExecutor, type DockerExecutorOptions } from "./docker.js";
import { DaytonaExecutor } from "./daytona.js";

export type { Executor, ExecResult, ExecOptions } from "./interface.js";
export { SandboxRegistry, idleTtlMsFromEnv } from "./registry.js";
export { reclaimOrphanedSandboxes } from "./docker.js";

export function createExecutor(options: DockerExecutorOptions = {}): Executor {
  const provider = process.env.SANDBOX_PROVIDER || "docker";

  switch (provider) {
    case "docker":
      return new DockerExecutor(options);
    case "daytona":
      // Daytona sandboxes are created ephemeral with an autoStopInterval, so
      // they reclaim themselves and need no ownership labels from us.
      return new DaytonaExecutor();
    default:
      throw new Error(`Unknown sandbox provider: ${provider}`);
  }
}
