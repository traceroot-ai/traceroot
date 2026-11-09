import { describe, expect, it } from "vitest";
import { DaytonaSandboxProvider, type SandboxHandle } from "../sandbox.js";

/**
 * Against the real Daytona service. It runs only when DAYTONA_API_KEY is set, creates its own
 * sandboxes (labelled by the provider) and destroys every one it created, whatever happens.
 * Sandboxes it did not create are never touched.
 */
const apiKey = process.env.DAYTONA_API_KEY;

/** The service's listing trails creation and deletion by a few seconds. */
async function eventually(check: () => Promise<boolean>, seconds = 60): Promise<boolean> {
  for (let waited = 0; waited <= seconds; waited += 3) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return false;
}

describe.skipIf(!apiKey)("Daytona provider against the live service", () => {
  it("blocks the network, moves files, lists and destroys, and reaches a git host when networked", async () => {
    const { Daytona } = await import("@daytonaio/sdk");
    const provider = new DaytonaSandboxProvider(
      new Daytona({ apiKey, apiUrl: "https://app.daytona.io/api", target: "us" }) as never,
    );
    const created: string[] = [];
    const mine: SandboxHandle[] = [];
    try {
      // A sandbox with the network blocked at creation.
      const blocked = await provider.create({ networkAccess: false });
      mine.push(blocked);
      created.push(blocked.id);
      expect(blocked.networkAccess).toBe(false);
      const echo = await blocked.exec("echo ok");
      expect(echo.code).toBe(0);
      expect(echo.stdout.toString().trim()).toBe("ok");

      // No egress: a plain fetch and a git remote both fail.
      const wget = await blocked.exec("wget -q -T 8 -O /dev/null https://example.com", {
        timeoutSec: 30,
      });
      expect(wget.code).not.toBe(0);
      const lsBlocked = await blocked.exec(
        "git ls-remote https://github.com/octocat/Hello-World.git HEAD",
        { timeoutSec: 45 },
      );
      expect(lsBlocked.code).not.toBe(0);

      // A file goes up and comes back unchanged.
      const payload = Buffer.from("traceroot sandbox round trip\n".repeat(50));
      await blocked.upload("/tmp/roundtrip.txt", payload);
      const back = await blocked.download("/tmp/roundtrip.txt");
      expect(Buffer.from(back).equals(payload)).toBe(true);

      // It shows up in the leak sweep; after destroying it, it does not.
      expect(await eventually(async () => (await provider.listLive()).includes(blocked.id))).toBe(
        true,
      );
      await blocked.destroy();
      mine.splice(mine.indexOf(blocked), 1);
      expect(await eventually(async () => !(await provider.listLive()).includes(blocked.id))).toBe(
        true,
      );

      // A sandbox with network reaches a git host (the same command that failed above).
      const open = await provider.create({ networkAccess: true });
      mine.push(open);
      created.push(open.id);
      expect(open.networkAccess).toBe(true);
      const ls = await open.exec("git ls-remote https://github.com/octocat/Hello-World.git HEAD", {
        timeoutSec: 60,
      });
      expect(ls.code).toBe(0);
      expect(ls.stdout.toString()).toMatch(/^[0-9a-f]{40}\s+HEAD/m);
    } finally {
      for (const box of mine) await box.destroy().catch(() => undefined);
    }
    // None of the ones this test created are left (other processes' sandboxes are not ours to judge).
    const gone = await eventually(async () => {
      const live = await provider.listLive();
      return created.every((id) => !live.includes(id));
    });
    expect(gone).toBe(true);
  }, 300_000);
});
