// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getSocialAuthConfig: vi.fn(),
  signInClient: vi.fn(),
  signUpClient: vi.fn(),
}));

vi.mock("@/lib/social-auth", () => ({
  getSocialAuthConfig: () => mocks.getSocialAuthConfig(),
}));

vi.mock("./sign-in/sign-in-client", () => ({
  SignInClient: (props: unknown) => {
    mocks.signInClient(props);
    return null;
  },
}));

vi.mock("./sign-up/sign-up-client", () => ({
  SignUpClient: (props: unknown) => {
    mocks.signUpClient(props);
    return null;
  },
}));

import SignInPage from "./sign-in/page";
import SignUpPage from "./sign-up/page";

beforeEach(() => {
  mocks.getSocialAuthConfig.mockReset();
  mocks.signInClient.mockReset();
  mocks.signUpClient.mockReset();
});

describe("auth pages", () => {
  it("passes enabled social providers to the sign-in client", () => {
    mocks.getSocialAuthConfig.mockReturnValue({
      enabledProviders: { google: true, github: false },
    });

    render(<SignInPage />);

    expect(mocks.signInClient).toHaveBeenCalledWith({
      enabledProviders: { google: true, github: false },
    });
  });

  it("passes enabled social providers to the sign-up client", () => {
    mocks.getSocialAuthConfig.mockReturnValue({
      enabledProviders: { google: false, github: true },
    });

    render(<SignUpPage />);

    expect(mocks.signUpClient).toHaveBeenCalledWith({
      enabledProviders: { google: false, github: true },
    });
  });
});
