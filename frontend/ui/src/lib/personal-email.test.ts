import { describe, expect, it } from "vitest";
import { PERSONAL_DOMAINS, companyDomainFrom, isPersonalEmail } from "./personal-email";

describe("isPersonalEmail", () => {
  // The sample addresses the lead service's filter tests use too.
  it.each([
    ["kai@gmail.com", true],
    ["Kai@GMAIL.com", true],
    ["kai@proton.me", true],
    ["kai@qq.com", true],
    ["kai@yahoo.co.jp", true],
    ["kai@duck.com", true],
    ["kai@sina.com", false],
    ["kai@rediffmail.com", false],
    ["kai@acme.com", false],
    ["kai@mail.acme.io", false],
    ["kai@stanford.edu", false],
    ["no-domain", true],
    ["", true],
  ])("%s → %s", (email, personal) => {
    expect(isPersonalEmail(email)).toBe(personal);
  });

  it("holds the lead service's 36 domains, all lower case", () => {
    expect(PERSONAL_DOMAINS.size).toBe(36);
    for (const domain of PERSONAL_DOMAINS) expect(domain).toBe(domain.toLowerCase());
  });
});

describe("companyDomainFrom", () => {
  it.each([
    ["acme.com", "acme.com"],
    ["  ACME.com ", "acme.com"],
    ["https://www.acme.com/about?x=1", "acme.com"],
    ["http://acme.co.uk:8080", "acme.co.uk"],
    ["kai@acme.io", "acme.io"],
    ["docs.acme.dev.", "docs.acme.dev"],
    ["Acme", null],
    ["Acme Inc.", null],
    ["", null],
    ["not a url.com", null],
  ])("%j → %j", (input, domain) => {
    expect(companyDomainFrom(input)).toBe(domain);
  });
});
