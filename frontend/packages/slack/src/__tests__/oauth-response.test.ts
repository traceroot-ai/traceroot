import { describe, expect, it } from "vitest";
import { SlackOAuthResponseSchema } from "../oauth-response.js";

describe("SlackOAuthResponseSchema", () => {
  it("parses a successful oauth.v2.access response", () => {
    const result = SlackOAuthResponseSchema.parse({
      ok: true,
      access_token: "xoxb-1234",
      token_type: "bot",
      bot_user_id: "U123",
      team: { id: "T123", name: "Acme" },
    });
    expect(result.access_token).toBe("xoxb-1234");
    expect(result.team.name).toBe("Acme");
  });

  it("rejects responses with ok:false", () => {
    expect(() => SlackOAuthResponseSchema.parse({ ok: false, error: "invalid_code" })).toThrow();
  });

  it("rejects token_type other than bot", () => {
    expect(() =>
      SlackOAuthResponseSchema.parse({
        ok: true,
        access_token: "xoxb-1",
        token_type: "user",
        bot_user_id: "U1",
        team: { id: "T1", name: "x" },
      }),
    ).toThrow();
  });
});
