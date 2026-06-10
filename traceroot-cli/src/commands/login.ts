import type { Command } from "commander";
import { notImplemented } from "../output.js";

/**
 * Registers the `traceroot login` command group.
 *
 * Subcommands:
 *   traceroot login   — read a personal access token from stdin and persist
 *                       it to ~/.traceroot/config.json
 *
 * Real implementation lands in #1083.
 */
export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("Authenticate with a TraceRoot workspace (reads token from stdin)")
    .action(() => notImplemented("login"));
}
