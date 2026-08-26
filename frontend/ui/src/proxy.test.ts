import { describe, it, expect } from "vitest";
import { config } from "./proxy";

/**
 * The middleware matcher is Next's negative-lookahead form: a path is PROTECTED
 * (the session-cookie middleware runs, redirecting to /auth/sign-in when there's
 * no cookie) iff it matches. Surfaces with their own auth — API-key public routes
 * (requireApiKeyProject), the internal API (X-Internal-Secret), auth routes — MUST
 * be exempt, or their requests get 307'd to sign-in before their handler runs.
 *
 * Regression guard for the api/public omission that 307'd every SDK request.
 */
const matcher = config.matcher[0];
const re = new RegExp(`^${matcher}$`);
const isProtected = (path: string) => re.test(path);

describe("middleware matcher exemptions", () => {
  it("exempts API-key public routes (Bearer auth, not a session cookie)", () => {
    expect(isProtected("/api/public/datasets")).toBe(false);
    expect(isProtected("/api/public/datasets/ds1/versions")).toBe(false);
    expect(isProtected("/api/public/evaluation-runs/run1/results/tc1/scores")).toBe(false);
  });

  it("exempts the other non-session surfaces", () => {
    expect(isProtected("/api/auth/callback")).toBe(false);
    expect(isProtected("/api/internal/validate-api-key")).toBe(false);
    expect(isProtected("/api/billing/webhook")).toBe(false);
  });

  it("still protects app pages and session-authed API routes", () => {
    expect(isProtected("/projects/p1/datasets")).toBe(true);
    expect(isProtected("/api/projects/p1/datasets")).toBe(true);
  });
});
