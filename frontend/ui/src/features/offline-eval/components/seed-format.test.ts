/**
 * Per-field seed formatting for captured values. The mode a freshly-captured
 * value opens in should be a property of the FIELD (input/output expand,
 * metadata stays inline), not of however the instrumented app happened to
 * serialise it — and plain text must never be mangled.
 */
import { describe, it, expect } from "vitest";
import { seedFormat } from "./code";

describe("seedFormat — expanded (input, recorded output)", () => {
  it("pretty-prints a compact JSON object", () => {
    const out = seedFormat('{"message":"I was charged twice"}', "expanded");
    expect(out.kind).toBe("pretty");
    expect(out.text).toBe('{\n  "message": "I was charged twice"\n}');
  });

  it("normalises an already-indented value to the same canonical shape", () => {
    const messy = '{\n    "a": 1\n}'; // 4-space indent from upstream
    const out = seedFormat(messy, "expanded");
    expect(out.kind).toBe("pretty");
    expect(out.text).toBe('{\n  "a": 1\n}'); // canonical 2-space
  });
});

describe("seedFormat — compact (metadata)", () => {
  it("keeps a small flat object on one line", () => {
    const out = seedFormat('{\n  "suite": "smoke"\n}', "compact");
    expect(out.kind).toBe("json");
    expect(out.text).toBe('{"suite":"smoke"}');
  });

  it("expands a NESTED value — one line stops being readable", () => {
    const out = seedFormat('{"suite":"smoke","owner":{"team":"billing"}}', "compact");
    expect(out.kind).toBe("pretty");
    expect(out.text).toContain('\n  "suite": "smoke"');
  });

  it("expands a LONG value even when flat", () => {
    const long = JSON.stringify({ note: "x".repeat(120) });
    const out = seedFormat(long, "compact");
    expect(out.kind).toBe("pretty");
    expect(out.text).toContain("\n");
  });

  it("keeps a short flat array inline", () => {
    const out = seedFormat('["smoke", "billing"]', "compact");
    expect(out.kind).toBe("json");
    expect(out.text).toBe('["smoke","billing"]');
  });
});

describe("seedFormat — non-JSON is never mangled", () => {
  it("leaves plain text exactly as-is", () => {
    for (const prefer of ["expanded", "compact"] as const) {
      const out = seedFormat("I forgot my password", prefer);
      expect(out.kind).toBe("text");
      expect(out.text).toBe("I forgot my password");
    }
  });

  it("leaves JSON-looking-but-invalid text as-is", () => {
    const broken = '{"a": 1,}';
    const out = seedFormat(broken, "expanded");
    expect(out.kind).toBe("text");
    expect(out.text).toBe(broken);
  });

  it("leaves an empty value alone", () => {
    expect(seedFormat("", "compact")).toEqual({ kind: "text", text: "" });
  });

  it("is idempotent — re-seeding an already-normalised value is a no-op", () => {
    const once = seedFormat('{"suite":"smoke"}', "compact");
    expect(seedFormat(once.text, "compact")).toEqual(once);
    const pretty = seedFormat('{"a":1}', "expanded");
    expect(seedFormat(pretty.text, "expanded")).toEqual(pretty);
  });
});
