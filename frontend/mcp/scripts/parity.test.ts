import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockRest } from "./mock-rest.js";

const run = promisify(execFile);

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
    const { stdout } = await run(
      new URL("../node_modules/.bin/vite-node", import.meta.url).pathname,
      [new URL("./parity-mock.ts", import.meta.url).pathname],
      { timeout: 120_000 },
    );
    expect(stdout).toContain("24 of 24 tools PASS");
    const rows = stdout.split("\n").filter((line) => line.startsWith("PASS"));
    expect(rows.filter((line) => line.endsWith("vs http"))).toHaveLength(4);
  }, 130_000);
});
