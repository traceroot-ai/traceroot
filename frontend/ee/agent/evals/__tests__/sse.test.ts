import { describe, expect, it } from "vitest";
import { createSseParser } from "../sse.js";

describe("createSseParser", () => {
  it("parses a complete event/data frame", () => {
    const parser = createSseParser();
    expect(parser.push('event: done\ndata: {"a":1}\n\n')).toEqual([
      { event: "done", data: '{"a":1}' },
    ]);
  });

  it("emits nothing until the frame's blank line arrives", () => {
    const parser = createSseParser();
    expect(parser.push("event: done\ndata: {}")).toEqual([]);
    expect(parser.push("\n\n")).toEqual([{ event: "done", data: "{}" }]);
  });

  it("reassembles a frame split mid-token across chunks", () => {
    const parser = createSseParser();
    expect(parser.push("event: tool_exec")).toEqual([]);
    expect(parser.push("ution_start\ndata: {")).toEqual([]);
    expect(parser.push('"x":2}\n\n')).toEqual([{ event: "tool_execution_start", data: '{"x":2}' }]);
  });

  it("returns several frames delivered in one chunk", () => {
    const parser = createSseParser();
    const frames = parser.push("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
    expect(frames).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("joins multi-line data with newlines, per the SSE spec", () => {
    const parser = createSseParser();
    expect(parser.push("event: a\ndata: one\ndata: two\n\n")).toEqual([
      { event: "a", data: "one\ntwo" },
    ]);
  });

  it('defaults the event name to "message" when the frame omits it', () => {
    const parser = createSseParser();
    expect(parser.push("data: hello\n\n")).toEqual([{ event: "message", data: "hello" }]);
  });

  it("ignores comment lines and unknown fields", () => {
    const parser = createSseParser();
    expect(parser.push(": keep-alive\nid: 7\nevent: a\ndata: 1\n\n")).toEqual([
      { event: "a", data: "1" },
    ]);
  });

  it("tolerates CRLF line endings", () => {
    const parser = createSseParser();
    expect(parser.push("event: a\r\ndata: 1\r\n\r\n")).toEqual([{ event: "a", data: "1" }]);
  });

  it("keeps a value's internal colons and strips only one leading space", () => {
    const parser = createSseParser();
    expect(parser.push("event: a\ndata:  http://x:8100\n\n")).toEqual([
      { event: "a", data: " http://x:8100" },
    ]);
  });

  it("drops a trailing partial frame that never terminated", () => {
    const parser = createSseParser();
    expect(parser.push("event: a\ndata: 1\n\nevent: b\ndata: 2")).toEqual([
      { event: "a", data: "1" },
    ]);
  });
});
