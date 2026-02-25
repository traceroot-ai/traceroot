import type { Executor, ExecResult, ExecOptions } from "./interface.js";

export class DaytonaExecutor implements Executor {
  async init(): Promise<void> {
    throw new Error("DaytonaExecutor not yet implemented. Use SANDBOX_PROVIDER=docker for dev.");
  }

  async exec(_command: string, _options?: ExecOptions): Promise<ExecResult> {
    throw new Error("Not implemented");
  }

  getWorkspacePath(): string {
    return "/workspace";
  }

  async writeFile(_path: string, _content: string): Promise<void> {
    throw new Error("Not implemented");
  }

  async readFile(_path: string): Promise<string> {
    throw new Error("Not implemented");
  }

  isReady(): boolean {
    return false;
  }

  async destroy(): Promise<void> {
    // No-op
  }
}
