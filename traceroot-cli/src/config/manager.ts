import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
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
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
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
