/**
 * Canonical stdout / stderr / exit-code contract for the CLI.
 *
 * Rules:
 *  - All user-facing output goes through these helpers — never bare console.log.
 *  - Colour is suppressed when the NO_COLOR env var is set or TERM is "dumb".
 *  - stderr is reserved for diagnostics (errors, warnings, progress).
 *  - stdout carries only machine-readable or table output so it can be piped.
 */

import chalk from "chalk";

const NO_COLOR =
  "NO_COLOR" in process.env || process.env["TERM"] === "dumb" || !process.stdout.isTTY;

if (NO_COLOR) {
  chalk.level = 0;
}

/** Write a line to stdout. */
export function println(line: string): void {
  process.stdout.write(line + "\n");
}

/** Write a line to stderr. */
export function eprintln(line: string): void {
  process.stderr.write(line + "\n");
}

/** Write a red "error: <message>" line to stderr. */
export function printError(message: string): void {
  eprintln(chalk.red(`error: ${message}`));
}

/** Write a yellow "warn: <message>" line to stderr. */
export function printWarn(message: string): void {
  eprintln(chalk.yellow(`warn: ${message}`));
}

function _exit(code: number): never {
  // Flush stderr before exiting. When stderr is piped, write("") returns
  // false and we wait for the drain event so buffered output is not lost.
  // When stderr is a TTY (or mocked in tests), write returns true and we
  // exit synchronously.
  if (!process.stderr.write("")) {
    process.stderr.once("drain", () => process.exit(code));
    return undefined as never;
  }
  process.exit(code);
}

/**
 * Write a "<command>: not yet implemented" message to stderr and exit 1.
 * Used by stub command actions until their issues land.
 */
export function notImplemented(command: string): never {
  eprintln(`${command}: not yet implemented`);
  _exit(1);
}

/** Write an error message to stderr and exit with the given code (default 1). */
export function fatal(message: string, exitCode = 1): never {
  printError(message);
  _exit(exitCode);
}
