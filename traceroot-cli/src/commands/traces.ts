import type { Command } from "commander";
import { notImplemented } from "../output.js";

/**
 * Registers the `traceroot traces` command group.
 *
 * Subcommands:
 *   traceroot traces list              — list recent traces as a table
 *   traceroot traces list --json       — newline-delimited JSON
 *   traceroot traces get <traceId>     — render span tree
 *   traceroot traces get <traceId> --json
 *
 * Real implementation lands in a follow-on issue.
 */
export function registerTraces(program: Command): void {
  const traces = program.command("traces").description("Inspect distributed traces");

  traces
    .command("list")
    .description("List recent traces")
    .option("-n, --limit <n>", "Maximum number of traces to return", (v) => parseInt(v, 10), 20)
    .option("--service <name>", "Filter by service name")
    .option("--from <iso>", "Start of time range (ISO 8601)")
    .option("--to <iso>", "End of time range (ISO 8601)")
    .option("--json", "Emit newline-delimited JSON instead of a table")
    .action(() => notImplemented("traces list"));

  traces
    .command("get <traceId>")
    .description("Fetch a single trace and render its span tree")
    .option("--json", "Emit raw JSON instead of a tree")
    .action(() => notImplemented("traces get"));
}
