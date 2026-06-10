import type { QueryKey } from "@tanstack/react-query";

/** One channel shared by all tabs of the app on this origin. */
export const QUERY_SYNC_CHANNEL = "traceroot-query-sync";

export interface QueryInvalidationMessage {
  type: "invalidate";
  queryKey: QueryKey;
}

export function isQueryInvalidationMessage(data: unknown): data is QueryInvalidationMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "invalidate" &&
    Array.isArray((data as { queryKey?: unknown }).queryKey)
  );
}

/**
 * Tell other tabs that queries under `queryKey` are stale so they refetch.
 * The posting tab is not notified (BroadcastChannel never echoes to its
 * sender) — callers rely on their own local invalidation for that. Cross-tab
 * sync is best-effort: where BroadcastChannel is unavailable or throws, this
 * silently does nothing.
 */
export function broadcastQueryInvalidation(queryKey: QueryKey): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(QUERY_SYNC_CHANNEL);
    const message: QueryInvalidationMessage = { type: "invalidate", queryKey };
    channel.postMessage(message);
    channel.close();
  } catch {
    // Best-effort only; the local cache was already invalidated by the caller.
  }
}

/**
 * Listen for invalidation messages from other tabs. Returns an unsubscribe
 * function (a no-op where BroadcastChannel is unavailable).
 */
export function subscribeToQueryInvalidations(
  onInvalidate: (queryKey: QueryKey) => void,
): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(QUERY_SYNC_CHANNEL);
  } catch {
    return () => {};
  }
  channel.addEventListener("message", (event: MessageEvent) => {
    if (isQueryInvalidationMessage(event.data)) onInvalidate(event.data.queryKey);
  });
  return () => channel.close();
}
