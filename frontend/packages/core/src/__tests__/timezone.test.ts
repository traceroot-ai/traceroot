import { describe, expect, it } from "vitest";
import { canonicalTimeZone, isValidTimeZone, tzOffsetMinutes } from "../lib/timezone.ts";

describe("timezone helpers", () => {
  it("accepts IANA names and rejects anything else", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });

  it("canonicalises the spelling and returns null for a non-zone", () => {
    expect(canonicalTimeZone("europe/berlin")).toBe("Europe/Berlin");
    expect(canonicalTimeZone("UTC")).toBe("UTC");
    expect(canonicalTimeZone("nope")).toBeNull();
  });

  it("reads the offset in force at the instant, east positive", () => {
    expect(tzOffsetMinutes(new Date("2026-01-15T12:00:00Z"), "Europe/Berlin")).toBe(60);
    expect(tzOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "Europe/Berlin")).toBe(120);
    expect(tzOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "America/New_York")).toBe(-240);
    expect(tzOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "Asia/Kolkata")).toBe(330);
  });
});
