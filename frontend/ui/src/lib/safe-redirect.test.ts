import { describe, expect, it } from "vitest";
import { sanitizeRedirectPath } from "./safe-redirect";

describe("sanitizeRedirectPath", () => {
  it("keeps same-origin absolute paths", () => {
    expect(sanitizeRedirectPath("/")).toBe("/");
    expect(sanitizeRedirectPath("/projects/proj_123/settings?tab=github#install")).toBe(
      "/projects/proj_123/settings?tab=github#install",
    );
  });

  it("falls back for external and protocol-relative URLs", () => {
    expect(sanitizeRedirectPath("https://evil.example/phish")).toBe("/");
    expect(sanitizeRedirectPath("http://evil.example/phish")).toBe("/");
    expect(sanitizeRedirectPath("//evil.example/phish")).toBe("/");
  });

  it("falls back for non-path inputs and dangerous schemes", () => {
    expect(sanitizeRedirectPath("dashboard")).toBe("/");
    expect(sanitizeRedirectPath("javascript:alert(1)")).toBe("/");
    expect(sanitizeRedirectPath("data:text/html,hello")).toBe("/");
  });

  it("falls back for ambiguous or malformed paths", () => {
    expect(sanitizeRedirectPath("/\\evil.example")).toBe("/");
    expect(sanitizeRedirectPath(" /dashboard")).toBe("/");
    expect(sanitizeRedirectPath("/dashboard\nLocation: https://evil.example")).toBe("/");
    expect(sanitizeRedirectPath(null)).toBe("/");
    expect(sanitizeRedirectPath(undefined)).toBe("/");
  });
});
