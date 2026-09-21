// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  socialAuthButtons: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams("callbackUrl=/projects/p1/traces"),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: {
      email: vi.fn(),
    },
    signUp: {
      email: vi.fn(),
    },
  },
}));

vi.mock("./social-auth-buttons", () => ({
  SocialAuthButtons: (props: unknown) => {
    mocks.socialAuthButtons(props);
    return <div data-testid="social-auth-buttons" />;
  },
}));

import { SignInClient } from "./sign-in/sign-in-client";
import { SignUpClient } from "./sign-up/sign-up-client";

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
  mocks.socialAuthButtons.mockReset();
});

describe("auth clients", () => {
  it("passes the sign-in callback URL through to social auth buttons", () => {
    render(<SignInClient enabledProviders={{ google: true, github: false }} />);

    expect(mocks.socialAuthButtons).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackURL: "/projects/p1/traces",
        enabledProviders: { google: true, github: false },
        verb: "sign in",
      }),
    );
  });

  it("uses onboarding as the sign-up social auth callback", () => {
    render(<SignUpClient enabledProviders={{ google: false, github: true }} />);

    expect(mocks.socialAuthButtons).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackURL: "/onboarding",
        enabledProviders: { google: false, github: true },
        verb: "sign up",
      }),
    );
  });
});
