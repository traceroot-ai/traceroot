import { describe, expect, it } from "vitest";
import { formatSessionAgent } from "./session-label";

describe("formatSessionAgent", () => {
  it("labels a traceroot-cli user-agent as TraceRoot CLI regardless of version", () => {
    expect(formatSessionAgent("traceroot-cli/1.2.3")).toBe("TraceRoot CLI");
    expect(formatSessionAgent("traceroot-cli/0.0.1-beta")).toBe("TraceRoot CLI");
  });

  it("summarizes a Chrome-on-macOS browser user-agent", () => {
    expect(
      formatSessionAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome on macOS");
  });

  it("prefers Edge over the Chrome token it also carries", () => {
    expect(
      formatSessionAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
      ),
    ).toBe("Edge on Windows");
  });

  it("summarizes a Firefox-on-Linux user-agent", () => {
    expect(
      formatSessionAgent("Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0"),
    ).toBe("Firefox on Linux");
  });

  it("summarizes Safari on iOS", () => {
    expect(
      formatSessionAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iOS");
  });

  it("falls back to the raw string when neither browser nor OS is recognized", () => {
    expect(formatSessionAgent("some-unknown-client/9")).toBe("some-unknown-client/9");
  });

  it("falls back to a generic label when there is no user-agent at all", () => {
    expect(formatSessionAgent(null)).toBe("Unknown device");
    expect(formatSessionAgent(undefined)).toBe("Unknown device");
    expect(formatSessionAgent("")).toBe("Unknown device");
  });
});
