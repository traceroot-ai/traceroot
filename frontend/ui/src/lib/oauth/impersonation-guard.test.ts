import { describe, expect, it } from "vitest";
import {
  assertNotImpersonating,
  isOAuthProviderPath,
  oauthImpersonationGuard,
} from "./impersonation-guard";

describe("assertNotImpersonating", () => {
  it("refuses an impersonated session", () => {
    expect(() => assertNotImpersonating({ impersonatedBy: "staff-1" })).toThrow(/impersonation/i);
  });

  it("lets an ordinary session, or none, through", () => {
    expect(() => assertNotImpersonating({ impersonatedBy: null })).not.toThrow();
    expect(() => assertNotImpersonating({})).not.toThrow();
    expect(() => assertNotImpersonating(null)).not.toThrow();
  });
});

describe("the OAuth endpoint guard", () => {
  const [hook] = oauthImpersonationGuard().hooks.before;

  it.each([
    "/oauth2/authorize",
    "/oauth2/consent",
    "/oauth2/continue",
    "/oauth2/get-consents",
    "/oauth2/register",
    "/oauth2/token",
  ])("covers %s", (path) => {
    expect(isOAuthProviderPath(path)).toBe(true);
    expect(hook.matcher({ path } as never)).toBe(true);
  });

  it.each(["/sign-in/email", "/get-session", "/support/start", "/jwks", undefined])(
    "leaves %s alone",
    (path) => {
      expect(isOAuthProviderPath(path)).toBe(false);
      expect(hook.matcher({ path } as never)).toBe(false);
    },
  );
});
