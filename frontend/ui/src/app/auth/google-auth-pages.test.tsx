import { describe, expect, it, vi } from "vitest";
import SignInPage from "./sign-in/page";
import { SignInClient } from "./sign-in/sign-in-client";
import SignUpPage from "./sign-up/page";
import { SignUpClient } from "./sign-up/sign-up-client";

vi.mock("@/env", () => ({
  env: {
    AUTH_GOOGLE_CLIENT_ID: " client-id ",
    AUTH_GOOGLE_CLIENT_SECRET: " client-secret ",
  },
}));

vi.mock("./sign-in/sign-in-client", () => ({
  SignInClient: function MockSignInClient() {
    return null;
  },
}));

vi.mock("./sign-up/sign-up-client", () => ({
  SignUpClient: function MockSignUpClient() {
    return null;
  },
}));

describe("auth pages", () => {
  it("passes Google auth readiness into the sign-in client", () => {
    expect(SignInPage()).toMatchObject({
      type: SignInClient,
      props: { googleAuthConfigured: true },
    });
  });

  it("passes Google auth readiness into the sign-up client", () => {
    expect(SignUpPage()).toMatchObject({
      type: SignUpClient,
      props: { googleAuthConfigured: true },
    });
  });
});
