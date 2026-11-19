import { describe, it, expect } from "vitest";
import { encodeJsonValue, decodeJsonValue, displayJsonValue, encodeEditedText } from "./json-value";

// The canonical public representation: encode-on-write, decode-on-read must round-trip
// every JSON value type — the crux of the dataset value contract with the SDK.
describe("dataset value round-trip", () => {
  const cases: Array<[string, unknown]> = [
    ["object", { a: 1, nested: { b: [1, 2] } }],
    ["array", [1, "two", true, null]],
    ["number", 42],
    ["float", 3.14],
    ["boolean true", true],
    ["boolean false", false],
    ["null", null],
    ["plain string", "hello world"],
    ["empty string", ""],
    // The lossy cases the naive text contract got wrong — genuine strings that look
    // like JSON must survive as strings, not be coerced to number/bool/array/null.
    ["numeric-looking string", "123"],
    ["boolean-looking string", "true"],
    ["array-looking string", "[1, 2]"],
    ["object-looking string", '{"a":1}'],
    ["null-looking string", "null"],
  ];

  it.each(cases)("round-trips a %s", (_label, value) => {
    expect(decodeJsonValue(encodeJsonValue(value))).toEqual(value);
  });

  it("preserves the type of a JSON-looking string (not coerced)", () => {
    expect(typeof decodeJsonValue(encodeJsonValue("123"))).toBe("string");
    expect(typeof decodeJsonValue(encodeJsonValue(123))).toBe("number");
    expect(decodeJsonValue(encodeJsonValue("true"))).toBe("true");
    expect(decodeJsonValue(encodeJsonValue(true))).toBe(true);
  });

  it("falls back to the raw string for legacy plain-text (non-JSON) rows", () => {
    // A value stored before JSON-encoding, e.g. plain text, is returned unchanged.
    expect(decodeJsonValue("just some plain text")).toBe("just some plain text");
    expect(decodeJsonValue(null)).toBeNull();
  });
});

describe("displayJsonValue (session/UI text form)", () => {
  it("shows a genuine string as-is, never quoted", () => {
    expect(displayJsonValue(encodeJsonValue("hello"))).toBe("hello");
    expect(displayJsonValue(encodeJsonValue("123"))).toBe("123");
  });

  it("shows structured values as pretty JSON", () => {
    expect(displayJsonValue(encodeJsonValue({ a: 1 }))).toBe('{\n  "a": 1\n}');
  });

  it("shows an empty string for null/absent", () => {
    expect(displayJsonValue(null)).toBe("");
    expect(displayJsonValue(encodeJsonValue(null))).toBe("");
  });

  it("passes legacy plain text through", () => {
    expect(displayJsonValue("plain legacy input")).toBe("plain legacy input");
  });
});

// The UI edits values as the text displayJsonValue produced, so re-encoding has to
// put back a value of the same kind — otherwise a UI save changes a case's type
// inside an immutable snapshot a run scores against.
describe("encodeEditedText (UI edit → stored encoding)", () => {
  const roundTrip = (value: unknown, edited?: string) => {
    const stored = encodeJsonValue(value);
    return decodeJsonValue(encodeEditedText(stored, edited ?? displayJsonValue(stored)));
  };

  it("keeps a genuine JSON-looking string a string", () => {
    expect(roundTrip("123")).toBe("123");
    expect(roundTrip("true")).toBe("true");
    expect(roundTrip("null")).toBe("null");
    expect(roundTrip('{"a":1}')).toBe('{"a":1}');
  });

  it("keeps structured and scalar values in their own kind", () => {
    expect(roundTrip({ a: 1 })).toEqual({ a: 1 });
    expect(roundTrip([1, 2])).toEqual([1, 2]);
    expect(roundTrip(42)).toBe(42);
    expect(roundTrip(true)).toBe(true);
  });

  it("carries an edit through", () => {
    expect(roundTrip("hello", "goodbye")).toBe("goodbye");
    expect(roundTrip({ a: 1 }, '{"a": 2}')).toEqual({ a: 2 });
    expect(roundTrip(42, "43")).toBe(43);
  });

  it("falls back to a string when a structured value is edited into free text", () => {
    expect(roundTrip({ a: 1 }, "not json any more")).toBe("not json any more");
  });

  it("treats a legacy plain-text row as a string", () => {
    expect(decodeJsonValue(encodeEditedText("legacy text", "123"))).toBe("123");
    expect(decodeJsonValue(encodeEditedText(null, "123"))).toBe("123");
  });
});
