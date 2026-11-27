import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPOSED_TOOLS } from "../src/exposure.js";
import { startMockRest } from "./mock-rest.js";
import { CASES, coverageGaps } from "./parity-cases.js";

const run = promisify(execFile);
const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const viteNode = path("../node_modules/.bin/vite-node");

describe("mock rest bearer handling", () => {
  let rest: Awaited<ReturnType<typeof startMockRest>>;
  beforeAll(async () => {
    rest = await startMockRest("tr-right");
  });
  afterAll(() => {
    rest.server.close();
  });

  const get = (authorization?: string) =>
    fetch(`${rest.url}/api/v1/public/traces`, authorization ? { headers: { authorization } } : {});

  it("answers a correct key", async () => {
    expect((await get("Bearer tr-right")).status).toBe(200);
  });

  it("refuses a wrong tr- key with 401", async () => {
    expect((await get("Bearer tr-wrong")).status).toBe(401);
  });

  it("takes the key path for a tr- prefix in any case", async () => {
    expect((await get("Bearer TR-wrong")).status).toBe(401);
    expect((await get("Bearer Tr-right")).status).toBe(401);
  });

  it("answers a bearer that is not a tr- key with the project_id 400", async () => {
    const response = await get("Bearer something-else");
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("project_id");
  });

  it("refuses a missing credential with 401", async () => {
    expect((await get()).status).toBe(401);
  });
});

describe("parity harness against fixtures", () => {
  it("passes all 24 tools, 20 against the CLI and 4 against plain HTTP", async () => {
    const { stdout } = await run(viteNode, [path("./parity-mock.ts")], { timeout: 120_000 });
    expect(stdout).toContain("24 of 24 tools PASS");
    const rows = stdout.split("\n").filter((line) => line.startsWith("PASS"));
    expect(rows.filter((line) => line.endsWith("vs http"))).toHaveLength(4);
  }, 130_000);

  it("fails on an --only name that matches no tool", async () => {
    const failure = await run(
      viteNode,
      [
        path("./parity.ts"),
        "--",
        "--url",
        "http://127.0.0.1:1/mcp",
        "--key",
        "tr-x",
        "--host",
        "http://127.0.0.1:1",
        "--only",
        "get_trce",
      ],
      { timeout: 60_000 },
    ).then(
      () => undefined,
      (error: { stderr: string }) => error,
    );
    expect(failure?.stderr).toContain("matches no tool");
  }, 70_000);

  it("refuses a flag that would point the fixture run somewhere else", async () => {
    const failure = await run(
      viteNode,
      [path("./parity-mock.ts"), "--url", "http://live.invalid/mcp"],
      {
        timeout: 60_000,
      },
    ).then(
      () => undefined,
      (error: { stderr: string }) => error,
    );
    expect(failure?.stderr).toContain("--url: parity:mock sets");
  }, 70_000);
});

describe("parity coverage", () => {
  it("has a case for every exposed tool and none for anything else", () => {
    expect(
      coverageGaps(
        EXPOSED_TOOLS,
        CASES.map((c) => c.tool),
      ),
    ).toEqual([]);
  });

  it("names an exposed tool with no verdict and a case for an unexposed tool", () => {
    expect(coverageGaps(["get_trace", "list_traces"], ["get_trace", "delete_trace"])).toEqual([
      "list_traces: exposed but has no parity verdict; add a case",
      "delete_trace: has a parity case but is not exposed",
    ]);
  });
});
