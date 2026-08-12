import { describe, expect, it } from "vitest";
import { formatUserCode, generateUserCode } from "../device-user-code";

const UNAMBIGUOUS_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const AMBIGUOUS_CHARS = ["0", "O", "1", "I"];
const SAMPLES = 200;

describe("generateUserCode", () => {
  it("returns an 8-character code with no hyphen", () => {
    for (let i = 0; i < SAMPLES; i++) {
      const code = generateUserCode();
      expect(code).toHaveLength(8);
      expect(code).not.toContain("-");
    }
  });

  it("only uses characters from the unambiguous alphabet", () => {
    for (let i = 0; i < SAMPLES; i++) {
      const code = generateUserCode();
      for (const char of code) {
        expect(UNAMBIGUOUS_ALPHABET).toContain(char);
        expect(AMBIGUOUS_CHARS).not.toContain(char);
      }
    }
  });
});

describe("formatUserCode", () => {
  it("inserts exactly one hyphen, producing a 4-1-4 shape", () => {
    const raw = generateUserCode();
    const formatted = formatUserCode(raw);
    expect(formatted).toHaveLength(9);
    expect(formatted.split("-")).toHaveLength(2);
    expect(formatted).toBe(`${raw.slice(0, 4)}-${raw.slice(4)}`);
    expect(formatted).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("round-trips: stripping the hyphen recovers the raw code", () => {
    for (let i = 0; i < SAMPLES; i++) {
      const raw = generateUserCode();
      const formatted = formatUserCode(raw);
      expect(formatted.replace(/-/g, "")).toBe(raw);
    }
  });
});
