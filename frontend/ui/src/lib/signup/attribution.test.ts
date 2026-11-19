import { describe, expect, it } from "vitest";
import { isSelfSignup, signupAttributionProperties } from "./attribution";

describe("signup attribution eligibility", () => {
  it("shares the staff-provisioning exclusion with signup notifications", () => {
    expect(isSelfSignup({ path: "/admin/create-user" })).toBe(false);
    expect(isSelfSignup({ path: "/sign-up/email" })).toBe(true);
    expect(isSelfSignup({ path: "/callback/:id" })).toBe(true);
  });

  it("has no campaign outside an HTTP request", () => {
    expect(signupAttributionProperties(null)).toEqual({});
  });
});
