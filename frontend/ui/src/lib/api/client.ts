/**
 * Base API client utilities for Traceroot
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

/**
 * Fetch from Python backend (for traces - needs user headers)
 */
export async function fetchTraceApi<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const { data: session } = await authClient.getSession();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (session?.user) {
    headers["x-user-id"] = session.user.id;
    if (session.user.email) headers["x-user-email"] = session.user.email;
    if (session.user.name) headers["x-user-name"] = session.user.name;
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
