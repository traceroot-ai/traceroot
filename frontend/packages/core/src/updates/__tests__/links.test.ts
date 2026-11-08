import { describe, expect, it } from "vitest";
import { signalLink, traceLink, updateLinks } from "../links.ts";

describe("update links", () => {
  it("builds project links without double slashes and encodes ids", () => {
    expect(updateLinks("https://app.example.com/", "p 1")).toEqual({
      dashboard: "https://app.example.com/projects/p%201/dashboard",
      traces: "https://app.example.com/projects/p%201/traces",
      signals: "https://app.example.com/projects/p%201/signals",
    });
    expect(traceLink("http://a", "p", "t/1")).toBe("http://a/projects/p/traces?traceId=t%2F1");
    expect(signalLink("http://a", "p", "s")).toBe("http://a/projects/p/signals?signalId=s");
  });
});
