import type { Executor } from "./interface.js";
import { DockerExecutor, type DockerExecutorOptions } from "./docker.js";
import { DaytonaExecutor } from "./daytona.js";

export type { Executor, ExecResult, ExecOptions } from "./interface.js";

/** The configured sandbox provider: "docker" unless SANDBOX_PROVIDER says otherwise. */
export function sandboxProvider(env: NodeJS.ProcessEnv = process.env): string {
  return env.SANDBOX_PROVIDER || "docker";
}

export function createExecutor(options: DockerExecutorOptions = {}): Executor {
  const provider = sandboxProvider();

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
