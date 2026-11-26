/**
 * The fast loop: start the fixture-backed rest stand-in and the MCP app on
 * local ports, then run the parity harness against them. FIXTURES, NOT THE LIVE
 * RESULT: the numbers this prints say the harness and the service agree on fake
 * data, nothing more.
 */
import { serve } from "@hono/node-server";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { startMockRest } from "./mock-rest.js";

const key = "tr-fixture-key";
// These point the harness at the fixtures; a user value would quietly run
// against something else under the fixture banner.
const fixed = ["--url", "--key", "--host", "--run-id"];
const userArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const clash = userArgs.find((arg) =>
  fixed.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
);
if (clash !== undefined) {
  throw new Error(
    `${clash}: parity:mock sets ${fixed.join(", ")} to the fixtures; use \`pnpm parity\` for a live run`,
  );
}
const rest = await startMockRest(key);
const app = serve({
  fetch: createApp({ backendUrl: rest.url }).fetch,
  port: 0,
  hostname: "127.0.0.1",
});
await new Promise((resolve) => app.once("listening", resolve));
const mcpUrl = `http://127.0.0.1:${(app.address() as { port: number }).port}/mcp`;

console.log(`FIXTURE-BACKED RUN (mock rest ${rest.url}, mcp ${mcpUrl})\n`);
const viteNode = fileURLToPath(new URL("../node_modules/.bin/vite-node", import.meta.url));
const child = spawn(
  viteNode,
  [
    fileURLToPath(new URL("./parity.ts", import.meta.url)),
    // User args first: parseArgs keeps the last value, so the fixed ones win.
    ...userArgs,
    "--url",
    mcpUrl,
    "--key",
    key,
    "--host",
    rest.url,
    "--run-id",
    "run-001",
  ],
  { stdio: "inherit" },
);
child.on("exit", (code) => {
  app.close();
  rest.server.close();
  process.exit(code ?? 1);
});
