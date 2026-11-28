import { describe, expect, it } from "vitest";
import { TRACE_KIND, messageTurnAttribution } from "../turn-attribution.js";

describe("messageTurnAttribution", () => {
  it("bills a person's turn in a system session as an RCA follow-up, a Loop's included", () => {
    expect(messageTurnAttribution({ userId: null }, "u1")).toEqual({
      turnKind: "rca_followup",
      initiatorUserId: "u1",
    });
  });

  it("makes a system turn an RCA execution and a user's session chat", () => {
    expect(messageTurnAttribution({ userId: null }, "")).toEqual({ turnKind: "rca_execution" });
    expect(messageTurnAttribution({ userId: "u1" }, "u1")).toEqual({ turnKind: "chat" });
  });

  it("traces a loop turn as kind loop", () => {
    expect(TRACE_KIND.loop_execution).toBe("loop");
  });
});
