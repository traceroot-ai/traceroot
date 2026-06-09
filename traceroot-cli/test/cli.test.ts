/**
 * Integration tests for the compiled binary.
 *
 * These tests run the actual `bin/traceroot.mjs` via Node so they exercise
 * the real commander wiring.  They require `npm run build` to have been run
 * first (dist/ must exist).  In CI, the build step always precedes this suite.
 * Locally, `npm test` triggers a build via the pretest hook.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "bin", "traceroot.mjs");
const DIST = join(__dirname, "..", "dist", "cli.js");
const PKG_VERSION = (
  JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

/** Run the binary with the given args, returning stdout, stderr, and exit code. */
function run(args: string[]): { stdout: string; stderr: string; code: number } {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? 1,
  };
}

const distExists = existsSync(DIST);

describe.skipIf(!distExists)("traceroot --help", () => {
  it("exits 0 and includes 'Usage:'", () => {
    const { stdout, code } = run(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("traceroot");
  });

  it("lists all registered subcommands", () => {
    const { stdout } = run(["--help"]);
    expect(stdout).toContain("login");
    expect(stdout).toContain("status");
    expect(stdout).toContain("traces");
  });
});

describe.skipIf(!distExists)("traceroot --version", () => {
  it("prints the package.json version and exits 0", () => {
    const { stdout, code } = run(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(PKG_VERSION);
  });
});

describe.skipIf(!distExists)("stub commands", () => {
  it("traceroot status exits 1 with 'not yet implemented'", () => {
    const { stderr, code } = run(["status"]);
    expect(code).toBe(1);
    expect(stderr).toContain("not yet implemented");
  });

  it("traceroot traces list exits 1 with 'not yet implemented'", () => {
    const { stderr, code } = run(["traces", "list"]);
    expect(code).toBe(1);
    expect(stderr).toContain("not yet implemented");
  });
});
