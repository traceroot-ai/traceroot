import { describe, expect, it } from "vitest";
import { publicErrorMessage } from "../lib/public-error.ts";

describe("publicErrorMessage", () => {
  it("returns an Error's message unchanged when it is short and plain", () => {
    expect(publicErrorMessage(new Error("RCA agent produced no output"))).toBe(
      "RCA agent produced no output",
    );
  });

  it("stringifies a non-Error value", () => {
    expect(publicErrorMessage("plain string failure")).toBe("plain string failure");
    expect(publicErrorMessage(404)).toBe("404");
  });

  it("keeps only the first line — later lines are usually a stack trace or provider dump", () => {
    const err = new Error("connection refused\n    at Socket.connect (net.js:123)\n    at ...");
    expect(publicErrorMessage(err)).toBe("connection refused");
  });

  it("redacts a credential-shaped value the same way persisted tool I/O is", () => {
    const err = new Error(
      "upstream auth failed: sk-abcdefghijklmnopqrstuvwxyz0123456789\nretrying in 5s",
    );
    const result = publicErrorMessage(err);
    expect(result).toBe("upstream auth failed: sk-[REDACTED]");
    expect(result).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("caps the result well short of a UI string: 200 bytes of UTF-8, marker included", () => {
    const err = new Error("x".repeat(500));
    const result = publicErrorMessage(err);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(200);
    expect(result.endsWith("…")).toBe(true);
  });

  it("never cuts inside a code point, so an emoji at the cap does not become a lone surrogate", () => {
    const result = publicErrorMessage(new Error("😀".repeat(300)));
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(200);
    expect(result).not.toContain("\uFFFD");
    expect(result.endsWith("…")).toBe(true);
  });

  it("blanks a credential-shaped key inside a JSON error body", () => {
    const result = publicErrorMessage(
      new Error(JSON.stringify({ error: "upstream", apiToken: "review-dummy-secret" })),
    );
    expect(result).not.toContain("review-dummy-secret");
    expect(result).toContain("upstream");
  });
});
