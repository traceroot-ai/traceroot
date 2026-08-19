// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  signInSocial: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: {
      social: (...args: unknown[]) => mocks.signInSocial(...args),
    },
  },
}));

import { SocialAuthButtons } from "./social-auth-buttons";

afterEach(() => {
  cleanup();
  mocks.signInSocial.mockReset();
});

describe("SocialAuthButtons", () => {
  it("renders nothing when no social providers are enabled", () => {
    const { container } = render(
      <SocialAuthButtons
        callbackURL="/after-auth"
        enabledProviders={{ google: false, github: false }}
        onError={vi.fn()}
        verb="sign in"
      />,
    );

    expect(container.textContent).toBe("");
  });

  it("starts the selected provider sign-in with the configured callback", async () => {
    mocks.signInSocial.mockResolvedValue({});
    const onError = vi.fn();

    render(
      <SocialAuthButtons
        callbackURL="/onboarding"
        enabledProviders={{ google: true, github: true }}
        onError={onError}
        verb="sign up"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue with GitHub" }));

    expect(onError).toHaveBeenCalledWith(null);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Redirecting..." }).disabled).toBe(
      true,
    );
    await waitFor(() =>
      expect(mocks.signInSocial).toHaveBeenCalledWith({
        provider: "github",
        callbackURL: "/onboarding",
      }),
    );
  });

  it("surfaces provider errors and re-enables the buttons", async () => {
    mocks.signInSocial.mockResolvedValue({ error: { message: "OAuth app is not configured" } });
    const onError = vi.fn();

    render(
      <SocialAuthButtons
        callbackURL="/"
        enabledProviders={{ google: true, github: false }}
        onError={onError}
        verb="sign in"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("OAuth app is not configured"));
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Continue with Google" }).disabled,
    ).toBe(false);
  });

  it("uses a provider-specific fallback message when the auth client returns an empty error", async () => {
    mocks.signInSocial.mockResolvedValue({ error: {} });
    const onError = vi.fn();

    render(
      <SocialAuthButtons
        callbackURL="/"
        enabledProviders={{ google: false, github: true }}
        onError={onError}
        verb="sign up"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue with GitHub" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("Failed to sign up with GitHub"));
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Continue with GitHub" }).disabled,
    ).toBe(false);
  });

  it("handles unexpected auth client failures", async () => {
    mocks.signInSocial.mockRejectedValue(new Error("network down"));
    const onError = vi.fn();

    render(
      <SocialAuthButtons
        callbackURL="/"
        enabledProviders={{ google: true, github: false }}
        onError={onError}
        verb="sign in"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("An unexpected error occurred"));
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Continue with Google" }).disabled,
    ).toBe(false);
  });
});
