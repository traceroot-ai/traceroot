import { describe, expect, it } from "vitest";
import type { GenericEndpointContext } from "@better-auth/core";
import { refuseUnverifiedGitHubSignUp, UNVERIFIED_EMAIL_CODE } from "./verified-social-email";

const via = (id?: string) =>
  ({
    path: id ? "/callback/:id" : "/sign-up/email",
    params: id ? { id } : {},
  }) as unknown as GenericEndpointContext;

describe("refuseUnverifiedGitHubSignUp", () => {
  it("refuses a GitHub sign-up whose email GitHub has not verified", async () => {
    await expect(
      refuseUnverifiedGitHubSignUp({ emailVerified: false }, via("github")),
    ).rejects.toMatchObject({ status: "FORBIDDEN", body: { code: UNVERIFIED_EMAIL_CODE } });
  });

  it.each<[string, boolean, GenericEndpointContext | null]>([
    ["a GitHub sign-up with a verified email", true, via("github")],
    ["a password sign-up", false, via()],
    ["another provider's sign-up", false, via("agentid")],
    ["a user made outside a request", false, null],
  ])("lets %s through", async (_case, emailVerified, context) => {
    await expect(refuseUnverifiedGitHubSignUp({ emailVerified }, context)).resolves.toBeUndefined();
  });
});
