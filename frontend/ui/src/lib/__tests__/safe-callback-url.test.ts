import { describe, expect, it } from "vitest";
import { safeCallbackUrl } from "../safe-callback-url";

describe("safeCallbackUrl", () => {
  it("falls back on missing or empty input", () => {
    expect(safeCallbackUrl(null)).toBe("/");
    expect(safeCallbackUrl(undefined)).toBe("/");
    expect(safeCallbackUrl("")).toBe("/");
  });

  it("accepts same-origin paths, preserving query and hash", () => {
    expect(safeCallbackUrl("/projects/p1/traces")).toBe("/projects/p1/traces");
    expect(safeCallbackUrl("/device?user_code=ABCD-1234")).toBe("/device?user_code=ABCD-1234");
    expect(safeCallbackUrl("/invites/abc#section")).toBe("/invites/abc#section");
  });

  it("normalizes a bare relative path onto the root", () => {
    expect(safeCallbackUrl("settings")).toBe("/settings");
  });

  it("rejects absolute URLs to foreign origins", () => {
    expect(safeCallbackUrl("https://evil.example/phish")).toBe("/");
    expect(safeCallbackUrl("http://evil.example")).toBe("/");
  });

  it("rejects protocol-relative URLs", () => {
    expect(safeCallbackUrl("//evil.example/phish")).toBe("/");
  });

  it("rejects dot-segment paths that normalize to a protocol-relative authority", () => {
    // The parse is same-origin, but `/..` collapses to leave a leading `//`,
    // which re-parses cross-origin at the redirect site.
    expect(safeCallbackUrl("/..//evil.example/phish")).toBe("/");
    expect(safeCallbackUrl("/../..//evil.example")).toBe("/");
    expect(safeCallbackUrl("/foo/..//evil.example")).toBe("/");
    expect(safeCallbackUrl("/.//evil.example")).toBe("/");
    expect(safeCallbackUrl("/%2e%2e//evil.example")).toBe("/");
  });

  it("never returns a protocol-relative or non-absolute path", () => {
    for (const raw of ["/..//evil.example", "//evil.example", "/\\evil.example", "javascript:x"]) {
      const out = safeCallbackUrl(raw);
      expect(out.startsWith("/")).toBe(true);
      expect(out.startsWith("//")).toBe(false);
    }
  });

  it("rejects the backslash authority trick", () => {
    // Browsers treat a backslash after the leading slash as a slash, turning
    // the value into a protocol-relative URL with a foreign authority.
    expect(safeCallbackUrl("/\\evil.example")).toBe("/");
    expect(safeCallbackUrl("\\/evil.example")).toBe("/");
    expect(safeCallbackUrl("\\\\evil.example")).toBe("/");
  });

  it("rejects non-http schemes", () => {
    expect(safeCallbackUrl("javascript:alert(1)")).toBe("/");
    expect(safeCallbackUrl("data:text/html,<script>alert(1)</script>")).toBe("/");
    expect(safeCallbackUrl("vbscript:msgbox(1)")).toBe("/");
  });

  it("uses the provided fallback for rejected values", () => {
    expect(safeCallbackUrl("https://evil.example", "/home")).toBe("/home");
    expect(safeCallbackUrl(null, "/home")).toBe("/home");
  });
});
