/**
 * Base API client utilities for TraceRoot
 */
import { authClient } from "@/lib/auth-client";
import { clientEnv } from "@/env.client";

// Python backend URL for trace APIs only
const TRACE_API_BASE = clientEnv.NEXT_PUBLIC_API_URL;

/**
 * Fetch from Next.js API routes (no auth headers needed, uses cookies)
 */
export async function fetchNextApi<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(error.error || `API error: ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export type TraceApiUser = { id: string; email?: string | null };

/**
 * Fetch from Python backend (for traces - needs user headers).
 * Pass `user` from a React hook's session to avoid a redundant getSession() call.
 */
export async function fetchTraceApi<T>(
  endpoint: string,
  options: RequestInit = {},
  user?: TraceApiUser,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (user?.id) {
    headers["x-user-id"] = user.id;
    if (user.email) headers["x-user-email"] = user.email;
    // x-user-name intentionally omitted: HTTP headers must be ASCII and the
    // backend does not use it. Non-ASCII names (e.g. Chinese characters) would
    // cause a TypeError in the browser's fetch API.
  } else {
    // Fallback: fetch session imperatively (for non-hook callers)
    const { data: session } = await authClient.getSession();
    if (session?.user) {
      headers["x-user-id"] = session.user.id;
      if (session.user.email) headers["x-user-email"] = session.user.email;
    }
  }

  const response = await fetch(`${TRACE_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "Unknown error" }));
    throw new Error(error.detail || `API error: ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}
