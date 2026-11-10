/**
 * The fast loop: start the fixture-backed rest stand-in and the MCP app on
 * local ports, then run the parity harness against them. FIXTURES, NOT THE LIVE
 * RESULT: the numbers this prints say the harness and the service agree on fake
 * data, nothing more.
 */
import { serve } from "@hono/node-server";
import { spawn } from "node:child_process";
import { createApp } from "../src/app.js";
import { startMockRest } from "./mock-rest.js";

const key = "tr-fixture-key";
const rest = await startMockRest(key);
const app = serve({
  fetch: createApp({ backendUrl: rest.url }).fetch,
  port: 0,
  hostname: "127.0.0.1",
});
await new Promise((resolve) => app.once("listening", resolve));
const mcpUrl = `http://127.0.0.1:${(app.address() as { port: number }).port}/mcp`;

console.log(`FIXTURE-BACKED RUN (mock rest ${rest.url}, mcp ${mcpUrl})\n`);
const viteNode = new URL("../node_modules/.bin/vite-node", import.meta.url).pathname;
const child = spawn(
  viteNode,
  [
    new URL("./parity.ts", import.meta.url).pathname,
    "--url",
    mcpUrl,
    "--key",
    key,
    "--host",
    rest.url,
    "--run-id",
    "run-001",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
child.on("exit", (code) => {
  app.close();
  rest.server.close();
  process.exit(code ?? 1);
});
