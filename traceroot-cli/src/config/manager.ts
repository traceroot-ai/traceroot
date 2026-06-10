import { homedir } from "os";
import { join } from "path";
import { readFileSync, mkdirSync, existsSync, openSync, writeSync, closeSync } from "fs";
import { type TraceRootConfig, DEFAULT_API_URL, isValidConfig } from "./schema.js";

export const CONFIG_DIR = join(homedir(), ".traceroot");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

let dirEnsured = false;

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
  } catch {
    // Malformed JSON — fall back to defaults silently.
  }
  return { apiUrl: DEFAULT_API_URL };
}

/**
 * Persist config to disk.
 * Creates ~/.traceroot/ if it does not already exist.
 */
export function writeConfig(config: TraceRootConfig): void {
  if (!dirEnsured) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    dirEnsured = true;
  }
  // Write with restrictive permissions from the start so the file is never
  // world-readable, even briefly.  mode 0o600 = owner read+write only.
  const data = JSON.stringify(config, null, 2) + "\n";
  const fd = openSync(CONFIG_FILE, "w", 0o600);
  try {
    writeSync(fd, data, 0, "utf8");
  } finally {
    closeSync(fd);
  }
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
