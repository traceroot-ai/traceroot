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
        errorCallbackURL: "/auth/error",
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

  it("re-enables every button when the page is restored from the back/forward cache", async () => {
    // A redirect that starts successfully never comes back through the error
    // paths, so the pending state is still set when the browser hands the tab
    // to the provider. Coming back restores this page from the back/forward
    // cache with the React state replayed verbatim - no remount, no effect -
    // so without a `pageshow` reset both buttons stay locked on "Redirecting...".
    mocks.signInSocial.mockResolvedValue({});

    render(
      <SocialAuthButtons
        callbackURL="/"
        enabledProviders={{ google: true, github: true }}
        onError={vi.fn()}
        verb="sign in"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue with GitHub" }));

    await waitFor(() => expect(mocks.signInSocial).toHaveBeenCalled());
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Redirecting..." }).disabled).toBe(
      true,
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Continue with Google" }).disabled,
    ).toBe(true);

    fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));

    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Continue with GitHub" }).disabled,
    ).toBe(false);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Continue with Google" }).disabled,
    ).toBe(false);
  });

  it("routes callback failures to the app error page for every provider", async () => {
    // Only errors raised before the redirect ever reach `onError`; anything
    // that fails on the OAuth callback is a server redirect, so the
    // destination is the only way those failures reach the user.
    mocks.signInSocial.mockResolvedValue({});

    render(
      <SocialAuthButtons
        callbackURL="/onboarding"
        enabledProviders={{ google: true, github: true }}
        onError={vi.fn()}
        verb="sign up"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(mocks.signInSocial).toHaveBeenCalledTimes(1));
    expect(mocks.signInSocial).toHaveBeenLastCalledWith({
      provider: "google",
      callbackURL: "/onboarding",
      errorCallbackURL: "/auth/error",
    });

    fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));

    fireEvent.click(screen.getByRole("button", { name: "Continue with GitHub" }));
    await waitFor(() => expect(mocks.signInSocial).toHaveBeenCalledTimes(2));
    expect(mocks.signInSocial).toHaveBeenLastCalledWith({
      provider: "github",
      callbackURL: "/onboarding",
      errorCallbackURL: "/auth/error",
    });
  });

  it("stops listening for restores once unmounted", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");

    try {
      const { unmount } = render(
        <SocialAuthButtons
          callbackURL="/"
          enabledProviders={{ google: true, github: false }}
          onError={vi.fn()}
          verb="sign in"
        />,
      );

      const registration = addEventListener.mock.calls.find(([type]) => type === "pageshow");
      expect(registration).toBeDefined();

      unmount();

      expect(removeEventListener).toHaveBeenCalledWith("pageshow", registration![1]);
    } finally {
      addEventListener.mockRestore();
      removeEventListener.mockRestore();
    }
  });
});
