import { describe, it, expect } from "vitest";

import { formatElapsed } from "./evaluations-view";

describe("formatElapsed", () => {
  it("renders a dash for a missing duration", () => {
    expect(formatElapsed(null)).toBe("—");
    expect(formatElapsed(undefined)).toBe("—");
  });

  it("formats each unit range", () => {
    expect(formatElapsed(150)).toBe("150ms");
    expect(formatElapsed(1500)).toBe("1.5s");
    expect(formatElapsed(65000)).toBe("1m 5s");
  });

  it("carries into the next unit instead of rendering a full smaller unit", () => {
    expect(formatElapsed(999.6)).toBe("1.0s");
    expect(formatElapsed(59960)).toBe("1m 0s");
    expect(formatElapsed(119700)).toBe("2m 0s");
    expect(formatElapsed(3599700)).toBe("60m 0s");
  });

  it("keeps values just below a boundary in the smaller unit", () => {
    expect(formatElapsed(999)).toBe("999ms");
    expect(formatElapsed(59940)).toBe("59.9s");
    expect(formatElapsed(119400)).toBe("1m 59s");
  });
});
