/**
 * Unified server auth exports
 * Automatically selects between Community Edition (mock) and Enterprise Edition (Clerk)
 * based on NEXT_PUBLIC_DISABLE_AUTH environment variable
 */

const IS_AUTH_DISABLED =
  process.env.NEXT_PUBLIC_DISABLE_AUTH === "true" ||
  process.env.NEXT_PUBLIC_LOCAL_MODE === "true";

let getAuthTokenAndHeaders: any;
let createBackendAuthHeaders: any;
let createFetchHeaders: any;

if (IS_AUTH_DISABLED) {
  // Community Edition: Use mock auth
  const ceServerAuth = require("./server-auth");
  getAuthTokenAndHeaders = ceServerAuth.getAuthTokenAndHeaders;
  createBackendAuthHeaders = ceServerAuth.createBackendAuthHeaders;
  createFetchHeaders = ceServerAuth.createFetchHeaders;
} else {
  // Enterprise Edition: Use Clerk auth
  try {
    const eeServerAuth = require("./ee/server-auth");
    getAuthTokenAndHeaders = eeServerAuth.getAuthTokenAndHeaders;
    createBackendAuthHeaders = eeServerAuth.createBackendAuthHeaders;
    createFetchHeaders = eeServerAuth.createFetchHeaders;
  } catch (error) {
    // Fallback to CE if EE not available
    const ceServerAuth = require("./server-auth");
    getAuthTokenAndHeaders = ceServerAuth.getAuthTokenAndHeaders;
    createBackendAuthHeaders = ceServerAuth.createBackendAuthHeaders;
    createFetchHeaders = ceServerAuth.createFetchHeaders;
  }
}

export { getAuthTokenAndHeaders, createBackendAuthHeaders, createFetchHeaders };

// Re-export types
export type { ServerAuthResult, ServerAuthHeaders } from "./types";
