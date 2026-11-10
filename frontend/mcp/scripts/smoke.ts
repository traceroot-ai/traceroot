/**
 * Drive a running MCP server the way an MCP client does: list the tools, then
 * call one. For checking a local stack by hand.
 *
 *   MCP_URL=http://localhost:8200/mcp TRACEROOT_API_KEY=tr-… \
 *     pnpm exec vite-node scripts/smoke.ts [tool] [json-args]
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = new URL(process.env.MCP_URL ?? "http://localhost:8200/mcp");
const key = process.env.TRACEROOT_API_KEY;
if (!key) {
  throw new Error("TRACEROOT_API_KEY is required");
}
const [tool = "list_traces", rawArgs = "{}"] = process.argv.slice(2);

const client = new Client({ name: "traceroot-mcp-smoke", version: "0.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  }),
);
const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
const result = await client.callTool({ name: tool, arguments: JSON.parse(rawArgs) });
console.log(JSON.stringify(result, null, 2));
await client.close();
