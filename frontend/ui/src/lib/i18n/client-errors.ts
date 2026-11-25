import type { MessageKey } from "./messages/en";
import type { Translate } from "./translate";

// When a request fails without a message of its own (a proxy's HTML error page, a dropped
// connection), the client falls back to an English message written where the request is made,
// before any language is known. This maps those fallbacks to keys when they are shown. A message
// the server sent is not listed and is shown as it arrived.
const EXACT_KEYS: Record<string, MessageKey> = {
  "Unknown error": "clientErrors.unknown",
  "Failed to change the status": "clientErrors.changeStatus",
  "Failed to revoke session": "clientErrors.revokeSession",
  "Failed to revoke other sessions": "clientErrors.revokeOtherSessions",
};

// The same, for fallbacks that end in the HTTP status: "Failed to fetch alerts: 502".
const STATUS_KEYS: Record<string, MessageKey> = {
  "API error": "clientErrors.api",
  "Request failed": "clientErrors.request",
  "Failed to fetch alerts": "clientErrors.fetchAlerts",
  "Failed to fetch alert": "clientErrors.fetchAlert",
  "Failed to create alert": "clientErrors.createAlert",
  "Failed to update alert": "clientErrors.updateAlert",
  "Failed to delete alert": "clientErrors.deleteAlert",
  "Failed to create detector": "clientErrors.createDetector",
};

/**
 * A client-side fallback error in the visitor's language; any other message is returned as given.
 * `String(error)` works too: its "Error: " prefix is dropped from a translated message.
 */
export function translateClientError<M extends string | null | undefined>(
  t: Translate,
  message: M,
): M | string {
  if (!message) return message;
  const bare = message.replace(/^Error: /, "");
  let translated: string | undefined;
  if (Object.hasOwn(EXACT_KEYS, bare)) {
    translated = t(EXACT_KEYS[bare]);
  } else {
    const match = /^(.+): (\d{3})$/.exec(bare);
    if (match && Object.hasOwn(STATUS_KEYS, match[1])) {
      translated = t(STATUS_KEYS[match[1]], { status: match[2] });
    }
  }
  // English comes back unchanged, so the text on screen is exactly what it was.
  return translated === undefined || translated === bare ? message : translated;
}
