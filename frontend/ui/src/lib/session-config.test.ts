import { describe, it, expect } from "vitest";
import {
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  SESSION_FRESH_AGE_SECONDS,
} from "./session-config";

describe("session config", () => {
  it("is a 7-day rolling window refreshed at most once per day", () => {
    expect(SESSION_EXPIRES_IN_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(SESSION_UPDATE_AGE_SECONDS).toBe(24 * 60 * 60);
    // updateAge must be shorter than the window, or the session could expire
    // between refreshes.
    expect(SESSION_UPDATE_AGE_SECONDS).toBeLessThan(SESSION_EXPIRES_IN_SECONDS);
  });

  it("disables the freshness gate so the Active Sessions UI can always load", () => {
    // 0 = better-auth never requires a fresh session; anything > 0 would 403
    // /list-sessions for sessions older than that (checked against createdAt),
    // breaking the revocation page for day-old logins.
    expect(SESSION_FRESH_AGE_SECONDS).toBe(0);
  });
});
