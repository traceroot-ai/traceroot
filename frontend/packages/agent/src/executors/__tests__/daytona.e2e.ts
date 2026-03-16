/**
 * E2E test for DaytonaExecutor against the real Daytona API.
 * Run with: dotenv -e ../../../../.env -- tsx src/executors/__tests__/daytona.e2e.ts
 *
 * Requires DAYTONA_API_KEY in .env
 */

import { DaytonaExecutor } from "../daytona.js";

async function runE2e() {
  console.log("=== DaytonaExecutor E2E Test ===\n");
  const executor = new DaytonaExecutor();

  try {
    // 1. Init
    console.log("1. Creating sandbox...");
    await executor.init();
    console.log(`   ✓ Sandbox ready at: ${executor.getWorkspacePath()}`);
    console.log(`   ✓ isReady(): ${executor.isReady()}`);
    console.log(`   ✓ hasNativeGit(): ${executor.hasNativeGit()}`);

    // 2. exec — basic command
    console.log("\n2. exec('echo hello from daytona')");
    const echoResult = await executor.exec("echo hello from daytona");
    console.log(`   stdout: ${echoResult.stdout.trim()}`);
    console.log(`   code:   ${echoResult.code}`);
    if (!echoResult.stdout.includes("hello from daytona")) throw new Error("echo failed");
    console.log("   ✓ exec works");

    // 3. exec — uname
    console.log("\n3. exec('uname -a')");
    const uname = await executor.exec("uname -a");
    console.log(`   ${uname.stdout.trim()}`);
    console.log("   ✓ uname works");

    // 4. writeFile / readFile
    console.log("\n4. writeFile / readFile");
    const testContent = "hello from traceroot e2e test\n";
    await executor.writeFile("/tmp/e2e-test.txt", testContent);
    console.log("   ✓ writeFile done");
    const readBack = await executor.readFile("/tmp/e2e-test.txt");
    console.log(`   readFile: ${readBack.trim()}`);
    if (!readBack.includes("hello from traceroot")) throw new Error("readFile content mismatch");
    console.log("   ✓ readFile matches");

    // 5. git clone (native)
    console.log("\n5. cloneRepo (native git) — public repo");
    const clonePath = `${executor.getWorkspacePath()}/repos/hello-world`;
    await executor.cloneRepo("https://github.com/octocat/Hello-World.git", clonePath);
    const lsResult = await executor.exec(`ls ${clonePath}`);
    console.log(`   files: ${lsResult.stdout.trim()}`);
    if (lsResult.code !== 0) throw new Error("clone or ls failed");
    console.log("   ✓ native git clone works");

    // 6. exec with timeout
    console.log("\n6. exec with timeout (2s)");
    const timeoutResult = await executor.exec("sleep 0.1 && echo done", { timeout: 2 });
    console.log(`   stdout: ${timeoutResult.stdout.trim()}, code: ${timeoutResult.code}`);
    console.log("   ✓ timeout exec works");

    console.log("\n=== All E2E checks passed! ✓ ===\n");
  } catch (err) {
    console.error("\n✗ E2E FAILED:", err);
    process.exit(1);
  } finally {
    // Always destroy
    console.log("Destroying sandbox...");
    await executor.destroy();
    console.log("✓ Sandbox destroyed, isReady():", executor.isReady());
  }
}

runE2e();
