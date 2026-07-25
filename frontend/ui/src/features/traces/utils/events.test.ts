import { describe, expect, it } from "vitest";
import { exceptionLabel, getExceptionInfos, parseSpanEvents } from "./events";

const STACKTRACE =
  "Traceback (most recent call last):\n" +
  '  File "/app/agents/checkout.py", line 42, in run_checkout\n' +
  "    total = subtotal / item_count\n" +
  "ZeroDivisionError: division by zero\n";

const EXCEPTION_EVENT = {
  name: "exception",
  timestamp: "2026-07-12T12:00:00.500000",
  attributes: {
    "exception.type": "ZeroDivisionError",
    "exception.message": "division by zero",
    "exception.stacktrace": STACKTRACE,
  },
};

describe("parseSpanEvents", () => {
  it("parses a normalized events blob", () => {
    const events = parseSpanEvents(JSON.stringify([EXCEPTION_EVENT]));
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("exception");
    expect(events[0].timestamp).toBe("2026-07-12T12:00:00.500000");
    expect(events[0].attributes["exception.type"]).toBe("ZeroDivisionError");
  });

  it("returns [] for null, undefined, and empty blobs", () => {
    expect(parseSpanEvents(null)).toEqual([]);
    expect(parseSpanEvents(undefined)).toEqual([]);
    expect(parseSpanEvents("")).toEqual([]);
  });

  it("returns [] for malformed JSON and non-array JSON", () => {
    expect(parseSpanEvents("{not json")).toEqual([]);
    expect(parseSpanEvents('{"name": "exception"}')).toEqual([]);
  });

  it("drops non-object entries and normalizes missing fields", () => {
    const events = parseSpanEvents(JSON.stringify(["bogus", 42, { attributes: null }, {}]));
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.name).toBe("");
      expect(event.timestamp).toBeNull();
      expect(event.attributes).toEqual({});
    }
  });
});

describe("getExceptionInfos", () => {
  it("extracts type/message/stacktrace from exception events only", () => {
    const events = parseSpanEvents(
      JSON.stringify([{ name: "cache.miss", timestamp: null, attributes: {} }, EXCEPTION_EVENT]),
    );
    const infos = getExceptionInfos(events);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toEqual({
      type: "ZeroDivisionError",
      message: "division by zero",
      stacktrace: STACKTRACE,
    });
  });

  it("drops exception events with no usable exception attributes", () => {
    const events = parseSpanEvents(
      JSON.stringify([{ name: "exception", timestamp: null, attributes: { other: "x" } }]),
    );
    expect(getExceptionInfos(events)).toEqual([]);
  });

  it("keeps partial exceptions (message only)", () => {
    const events = parseSpanEvents(
      JSON.stringify([
        { name: "exception", timestamp: null, attributes: { "exception.message": "boom" } },
      ]),
    );
    expect(getExceptionInfos(events)).toEqual([{ type: null, message: "boom", stacktrace: null }]);
  });
});

describe("exceptionLabel", () => {
  it("joins type and message", () => {
    expect(exceptionLabel({ type: "ValueError", message: "bad input", stacktrace: null })).toBe(
      "ValueError: bad input",
    );
  });

  it("falls back to whichever half exists", () => {
    expect(exceptionLabel({ type: "ValueError", message: null, stacktrace: null })).toBe(
      "ValueError",
    );
    expect(exceptionLabel({ type: null, message: "bad input", stacktrace: null })).toBe(
      "bad input",
    );
    expect(exceptionLabel({ type: null, message: null, stacktrace: "st" })).toBe("Exception");
  });
});
