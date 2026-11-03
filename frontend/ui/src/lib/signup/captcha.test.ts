import { describe, expect, it } from "vitest";
import { turnstileKeys } from "./captcha";

describe("turnstileKeys", () => {
  it("is on only when both keys are set", () => {
    expect(turnstileKeys({ TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" })).toEqual({
      siteKey: "site",
      secretKey: "secret",
    });
    // Either alone would reject every signup or render an unchecked widget.
    expect(turnstileKeys({ TURNSTILE_SITE_KEY: "site" })).toBeNull();
    expect(turnstileKeys({ TURNSTILE_SECRET_KEY: "secret" })).toBeNull();
    expect(turnstileKeys({ TURNSTILE_SITE_KEY: " ", TURNSTILE_SECRET_KEY: "secret" })).toBeNull();
    expect(turnstileKeys({})).toBeNull();
  });
});
