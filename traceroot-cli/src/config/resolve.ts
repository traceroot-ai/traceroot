/**
 * Auth resolution for the CLI.
 *
 * Priority (highest first):
 *   1. TRACEROOT_TOKEN environment variable
 *   2. token field in ~/.traceroot/config.json
 *
 * API URL and workspace follow the same precedence:
 *   1. TRACEROOT_API_URL / TRACEROOT_WORKSPACE env vars
 *   2. apiUrl / workspace fields in config
 */

import { readConfig } from "./manager.js";
import { fatal } from "../output.js";

export interface ResolvedAuth {
  apiUrl: string;
  token: string;
  workspace?: string;
  /** Where the token was found — useful for `traceroot status` output. */
  source: "env" | "config";
}

/**
 * Attempt to resolve auth credentials.
 * Returns null when no token is available (user is unauthenticated).
 */
export function resolveAuth(): ResolvedAuth | null {
  const config = readConfig();
  const apiUrl = process.env["TRACEROOT_API_URL"] || config.apiUrl;
  const workspace = process.env["TRACEROOT_WORKSPACE"] || config.workspace;

  const envToken = process.env["TRACEROOT_TOKEN"];
  if (envToken) {
    return { apiUrl, token: envToken, workspace, source: "env" };
  }

  if (config.token) {
    return { apiUrl, token: config.token, workspace, source: "config" };
  }

  return null;
}

/**
 * Like resolveAuth() but exits with a helpful message when no token is found.
 * Use this in command actions that require authentication.
 */
export function requireAuth(): ResolvedAuth {
  const auth = resolveAuth();
  if (!auth) {
    fatal("not authenticated — run `traceroot login token <TOKEN>` or set TRACEROOT_TOKEN");
  }
  return auth;
}
