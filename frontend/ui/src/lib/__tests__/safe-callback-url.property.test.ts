import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { safeCallbackUrl } from "../safe-callback-url";

// Property-based companion to safe-callback-url.test.ts. The example tests pin
// the known smuggling shapes; these assert the invariant for arbitrary input,
// including mixtures of the dangerous prefixes with random tails.

const FALLBACK = "/__fallback__";
const FOREIGN_BASE = "https://app.example";

// Prefixes that have historically turned a "relative" redirect cross-origin,
// followed by an arbitrary tail.
const hostileInput = fc
  .tuple(
    fc.constantFrom(
      "",
      "/",
      "//",
      "///",
      "/\\",
      "\\\\",
      "\\/",
      "/..//",
      "/%2f",
      " //",
      "\t//",
      "https://",
      "http:",
      "javascript:",
      "data:",
    ),
    fc.string(),
  )
  .map(([prefix, tail]) => prefix + tail);

const anyInput = fc.oneof(fc.string(), fc.string({ unit: "binary" }), hostileInput);

describe("safeCallbackUrl properties", () => {
  it("returns the fallback or a single-slash absolute path, never a protocol-relative one", () => {
    fc.assert(
      fc.property(anyInput, (raw) => {
        const out = safeCallbackUrl(raw, FALLBACK);
        if (out === FALLBACK) return;
        expect(out.startsWith("/")).toBe(true);
        expect(out.startsWith("//")).toBe(false);
        expect(out.startsWith("/\\")).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });

  it("never lets a redirect leave the current origin", () => {
    fc.assert(
      fc.property(anyInput, (raw) => {
        const out = safeCallbackUrl(raw, FALLBACK);
        expect(new URL(out, FOREIGN_BASE).origin).toBe(FOREIGN_BASE);
      }),
      { numRuns: 1000 },
    );
  });

  it("is idempotent: an accepted target stays accepted unchanged", () => {
    fc.assert(
      fc.property(anyInput, (raw) => {
        const once = safeCallbackUrl(raw, FALLBACK);
        expect(safeCallbackUrl(once, FALLBACK)).toBe(once);
      }),
      { numRuns: 1000 },
    );
  });

  it("rejects every protocol-relative input regardless of the tail", () => {
    fc.assert(
      fc.property(fc.constantFrom("//", "/\\", "\\\\", "\\/"), fc.string(), (prefix, tail) => {
        expect(safeCallbackUrl(prefix + tail, FALLBACK)).toBe(FALLBACK);
      }),
      { numRuns: 500 },
    );
  });

  it("accepts a plain path unchanged", () => {
    const segment = fc.stringMatching(/^[a-z0-9_-]{1,12}$/);
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), (segments) => {
        const path = "/" + segments.join("/");
        expect(safeCallbackUrl(path, FALLBACK)).toBe(path);
      }),
      { numRuns: 200 },
    );
  });
});
