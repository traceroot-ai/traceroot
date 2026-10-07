import { describe, expect, it } from "vitest";
import { isGoogleAuthConfigured } from "./auth-config";

describe("isGoogleAuthConfigured", () => {
  it("requires both Google auth credentials", () => {
    expect(isGoogleAuthConfigured("client-id", "client-secret")).toBe(true);
    expect(isGoogleAuthConfigured("", "client-secret")).toBe(false);
    expect(isGoogleAuthConfigured("client-id", "")).toBe(false);
  });

  it("treats whitespace-only credentials as missing", () => {
    expect(isGoogleAuthConfigured("  ", "client-secret")).toBe(false);
    expect(isGoogleAuthConfigured("client-id", "\t")).toBe(false);
  });
});
