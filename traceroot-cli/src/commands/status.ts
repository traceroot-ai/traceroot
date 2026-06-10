import type { Command } from "commander";
import { notImplemented } from "../output.js";

/**
 * Registers the `traceroot status` command.
 * Shows current auth status and the active workspace.
 *
 * Real implementation lands in #1083.
 */
export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show current auth status and active workspace")
    .action(() => notImplemented("status"));
}
