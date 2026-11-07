import { describe, it, expect } from "vitest";
import { describeCapture, withheldOutputText } from "../lib/capture-note.ts";

describe("describeCapture", () => {
  it("says what is missing and why for a result the allowlist dropped", () => {
    const note = describeCapture({ withheld: "not-allowlisted", outputBytes: 2175 });
    expect(note?.text).toBe("Output not stored after the run (2,175 bytes returned)");
    expect(note?.why).toMatch(/source code and secrets/);
    expect(note?.why).toMatch(/Trace and session downloads are kept/);
  });

  it("names the run's storage limit when the budget ran out", () => {
    const note = describeCapture({ withheld: "budget", outputBytes: 9001 });
    expect(note?.text).toBe(
      "Output not stored: this run reached its limit for stored tool output (9,001 bytes returned)",
    );
    expect(note?.why).toMatch(/bounded amount of tool output/);
  });

  it("explains a result cut at the per-step limit", () => {
    const note = describeCapture({ withheld: null, truncated: true, outputBytes: 50_000 });
    expect(note?.text).toBe("Output stored up to the per-step limit (50,000 bytes returned)");
  });

  it("omits the size when it is unknown and says nothing for a kept result", () => {
    expect(describeCapture({ withheld: "not-allowlisted" })?.text).toBe(
      "Output not stored after the run",
    );
    expect(describeCapture({ withheld: null, truncated: false, outputBytes: 12 })).toBeNull();
  });
});

describe("withheldOutputText", () => {
  it("joins the statement and the reason so a span reads on its own", () => {
    expect(withheldOutputText({ withheld: "not-allowlisted", outputBytes: 106 })).toBe(
      "Output not stored after the run (106 bytes returned). Shell, file and git output can " +
        "include your source code and secrets, so it is shown while the run streams but not " +
        "kept afterwards. Trace and session downloads are kept.",
    );
  });

  it("never yields a bare policy verdict, even for an unexpected verdict shape", () => {
    const text = withheldOutputText({ withheld: null, outputBytes: 7 });
    expect(text).toMatch(/^Output not stored after the run \(7 bytes returned\)\. /);
    expect(text).not.toMatch(/\[withheld/);
  });
});
