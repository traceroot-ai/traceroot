import { describe, it, expect } from "vitest";
import {
  encodeJsonValue,
  decodeJsonValue,
  displayJsonValue,
  encodeEditedText,
  canonicalJson,
  canonicalInputKey,
} from "./json-value";

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

// Deterministic serialization used both to content-sign a dataset version and to align
// run-comparison rows: two STRUCTURALLY equal values must serialize identically.
describe("canonicalJson (key-order-independent serialization)", () => {
  it("serializes object keys in a stable (sorted) order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it("sorts keys recursively through nested objects and arrays", () => {
    expect(canonicalJson({ outer: { y: 1, x: 2 }, list: [{ q: 1, p: 2 }] })).toBe(
      canonicalJson({ list: [{ p: 2, q: 1 }], outer: { x: 2, y: 1 } }),
    );
  });

  it("preserves array element order (only object keys are reordered)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("serializes scalars and null the same as JSON", () => {
    expect(canonicalJson(123)).toBe("123");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
  });
});

// The alignment key that lets a run comparison line up cases ACROSS datasets by their
// shared input, regardless of key order or how the value happened to be stored.
describe("canonicalInputKey (cross-dataset input alignment)", () => {
  it("maps two objects that differ only in key order to the same key", () => {
    expect(canonicalInputKey('{"b":1,"a":2}')).toBe(canonicalInputKey('{"a":2,"b":1}'));
  });

  it("maps structurally equal nested objects/arrays to the same key", () => {
    const a = encodeJsonValue({ msgs: [{ role: "user", text: "hi" }], n: 1 });
    const b = encodeJsonValue({ n: 1, msgs: [{ text: "hi", role: "user" }] });
    expect(canonicalInputKey(a)).toBe(canonicalInputKey(b));
  });

  it("keeps genuinely different inputs apart", () => {
    expect(canonicalInputKey(encodeJsonValue("hello"))).not.toBe(
      canonicalInputKey(encodeJsonValue("world")),
    );
    expect(canonicalInputKey('{"a":1}')).not.toBe(canonicalInputKey('{"a":2}'));
  });

  it("aligns a legacy plain-text value with its JSON-encoded form of the SAME type", () => {
    // A run RESULT's `input` has no enforced encoding: the same value can arrive as legacy
    // plain text or JSON-encoded. Decoding converges them when the type matches — legacy
    // plain text that isn't valid JSON stays a string and matches a JSON string:
    expect(canonicalInputKey("hello world")).toBe(
      canonicalInputKey(encodeJsonValue("hello world")),
    );
    // ...and legacy plain text that parses as a number/boolean matches the same-typed value:
    expect(canonicalInputKey("123")).toBe(canonicalInputKey(encodeJsonValue(123)));
    expect(canonicalInputKey("true")).toBe(canonicalInputKey(encodeJsonValue(true)));
  });

  it("keeps scalars of different types apart even when their text is equal", () => {
    // A JSON string and a number/boolean that share the same text are DIFFERENT inputs and
    // must not be aligned as one row — otherwise a case would compare against the wrong
    // baseline row, showing misleading scores/outputs/deltas.
    expect(canonicalInputKey(encodeJsonValue("123"))).not.toBe(
      canonicalInputKey(encodeJsonValue(123)),
    );
    expect(canonicalInputKey(encodeJsonValue("true"))).not.toBe(
      canonicalInputKey(encodeJsonValue(true)),
    );
  });

  it("does not collide a genuine JSON-looking string with the object it resembles", () => {
    // The string "{\"a\":1}" and the object {a:1} are different inputs and stay apart.
    expect(canonicalInputKey(encodeJsonValue('{"a":1}'))).not.toBe(
      canonicalInputKey(encodeJsonValue({ a: 1 })),
    );
  });
});
