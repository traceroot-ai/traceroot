import { describe, expect, it } from "vitest";
import { checkSignupEmail } from "./email-policy";
import { DISPOSABLE_DOMAINS } from "./disposable-domains";

describe("checkSignupEmail", () => {
  it.each([
    "kai@traceroot.ai",
    "kai@gmail.com",
    "kai@mail.company.co.uk",
    "kai+tag@company.io",
    // Lookalikes of reserved and disposable names are ordinary domains.
    "kai@example.co",
    "kai@myexample.com",
    "kai@examples.com",
    "kai@notmailinator.com",
    "kai@mailinator.com.au",
    "kai@test.com",
    "kai@localhost.dev",
  ])("accepts %s", (email) => {
    expect(checkSignupEmail(email)).toEqual({ ok: true });
  });

  it.each([
    "kai@example.com",
    "kai@example.net",
    "kai@example.org",
    "kai@mail.example.com",
    "kai@foo.test",
    "kai@foo.example",
    "kai@foo.invalid",
    "kai@foo.localhost",
    "kai@printer.local",
    "kai@abc.onion",
    "kai@router.home.arpa",
    "kai@corp.internal",
    "kai@localhost",
    "kai@[127.0.0.1]",
  ])("rejects reserved %s", (email) => {
    expect(checkSignupEmail(email)).toEqual({ ok: false, reason: "reserved" });
  });

  it.each([
    "kai@mailinator.com",
    "kai@yopmail.com",
    "kai@guerrillamail.com",
    "kai@10minutemail.com",
    "kai@sub.mailinator.com",
  ])("rejects disposable %s", (email) => {
    expect(checkSignupEmail(email)).toEqual({ ok: false, reason: "disposable" });
  });

  it.each([
    ["case", "Kai@EXAMPLE.COM", "reserved"],
    ["a trailing root dot", "kai@example.com.", "reserved"],
    ["surrounding whitespace", "kai@mailinator.com ", "disposable"],
    ["a quoted local part containing @", '"a@b"@yopmail.com', "disposable"],
  ])("normalizes %s", (_label, email, reason) => {
    expect(checkSignupEmail(email)).toEqual({ ok: false, reason });
  });

  it("keeps the vendored list normalized so every entry can match", () => {
    for (const domain of DISPOSABLE_DOMAINS) {
      expect(domain).toBe(domain.trim().toLowerCase());
      expect(domain).not.toMatch(/^\.|\.$/);
      expect(domain).toContain(".");
    }
  });
});
