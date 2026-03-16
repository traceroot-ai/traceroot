import { describe, it, expect } from "vitest";
import type { Executor } from "../interface.js";

describe("Executor interface", () => {
  it("allows executor without native git methods", () => {
    // DockerExecutor-style: no cloneRepo or hasNativeGit
    const executor: Executor = {
      init: async () => {},
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      getWorkspacePath: () => "/workspace",
      writeFile: async () => {},
      readFile: async () => "",
      isReady: () => true,
      destroy: async () => {},
    };
    // Should not have native git
    expect(executor.cloneRepo).toBeUndefined();
    expect(executor.hasNativeGit).toBeUndefined();
  });

  it("allows executor with native git methods", () => {
    // DaytonaExecutor-style: has cloneRepo and hasNativeGit
    const executor: Executor = {
      init: async () => {},
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      getWorkspacePath: () => "/workspace",
      writeFile: async () => {},
      readFile: async () => "",
      isReady: () => true,
      destroy: async () => {},
      cloneRepo: async () => {},
      hasNativeGit: () => true,
    };
    expect(executor.hasNativeGit!()).toBe(true);
  });
});
