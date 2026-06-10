import { homedir } from "os";
import { join } from "path";
import {
  readFileSync,
  mkdirSync,
  existsSync,
  openSync,
  writeSync,
  closeSync,
  renameSync,
  chmodSync,
} from "fs";
import { type TraceRootConfig, DEFAULT_API_URL, isValidConfig } from "./schema.js";

export const CONFIG_DIR = join(homedir(), ".traceroot");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

/**
 * Read config from disk.
 * Returns sensible defaults if the file is absent or contains malformed JSON.
 */
export function readConfig(): TraceRootConfig {
  if (!existsSync(CONFIG_FILE)) {
    return { apiUrl: DEFAULT_API_URL };
  }
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isValidConfig(parsed)) return parsed;
  } catch (err) {
    // Re-throw filesystem errors (permission denied, etc.). Only swallow
    // JSON syntax errors and shape mismatches — those are recoverable by
    // falling back to defaults.
    if (!(err instanceof SyntaxError)) throw err;
  }
  return { apiUrl: DEFAULT_API_URL };
}

/**
 * Persist config to disk.
 * Creates ~/.traceroot/ if it does not already exist.
 */
export function writeConfig(config: TraceRootConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Write atomically via a temp file so an interrupted write never leaves
  // a truncated config.  renameSync is atomic on the same filesystem.
  const data = JSON.stringify(config, null, 2) + "\n";
  const tmp = CONFIG_FILE + ".tmp." + Date.now() + "." + process.pid;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data, 0, "utf8");
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, CONFIG_FILE);
  // Enforce restrictive permissions on every write.  openSync mode only
  // applies when the file is created; an existing file keeps its old mode,
  // which may have been relaxed by another tool or a prior version.
  chmodSync(CONFIG_FILE, 0o600);
}

/**
 * Merge a partial update into the existing config and persist.
 * Returns the merged config.
 */
export function updateConfig(patch: Partial<TraceRootConfig>): TraceRootConfig {
  const current = readConfig();
  const next: TraceRootConfig = { ...current, ...patch };
  writeConfig(next);
  return next;
}
