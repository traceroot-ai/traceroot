// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  signUpEmail: vi.fn(),
  signInSocial: vi.fn(),
}));

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
  useSearchParams: () => searchParams,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signUp: { email: (...args: unknown[]) => mocks.signUpEmail(...args) },
    signIn: { social: (...args: unknown[]) => mocks.signInSocial(...args) },
  },
}));

import { SignUpClient } from "../sign-up-client";

function setParams(params: Record<string, string>) {
  searchParams = new URLSearchParams(params);
}

function fillForm() {
  fireEvent.change(screen.getByPlaceholderText("John Doe"), { target: { value: "Kai" } });
  fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
    target: { value: "kai@example.com" },
  });
  const passwords = screen.getAllByPlaceholderText("********");
  fireEvent.change(passwords[0], { target: { value: "password123" } });
  fireEvent.change(passwords[1], { target: { value: "password123" } });
}

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
  mocks.refresh.mockReset();
  mocks.signUpEmail.mockReset();
  mocks.signInSocial.mockReset();
  searchParams = new URLSearchParams();
});

describe("SignUpClient", () => {
  it("sends a normal signup straight to onboarding", async () => {
    mocks.signUpEmail.mockResolvedValue({ error: null });

    render(<SignUpClient googleAuthConfigured={false} />);
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/onboarding"));
  });

  it("routes a device-login signup through onboarding, carrying the device URL back", async () => {
    // Onboarding has to run before the device code is approved. Approving first
    // releases the waiting CLI, which immediately asks the account for a project
    // — and a brand-new account has no workspace to hold one until this form is
    // submitted.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.signUpEmail.mockResolvedValue({ error: null });

    render(<SignUpClient googleAuthConfigured={false} />);
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalled());
    const dest = mocks.push.mock.calls[0][0] as string;
    expect(dest.startsWith("/onboarding?")).toBe(true);
    expect(dest).toContain(`callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234")}`);
  });

  it("passes the same onboarding destination to Google sign-up", async () => {
    // `signIn.social` is better-auth's only social entry point, so this button
    // signs an existing account in as readily as it creates one — and with
    // Google a trusted linking provider, it also answers for an existing email
    // account at the same address. Both land on onboarding without being new,
    // which is why onboarding checks the account rather than trusting the route:
    // see "hands an account that already owns a workspace straight back" in
    // app/onboarding/page.test.tsx. Splitting the destination here instead (with
    // better-auth's `newUserCallbackURL`) would put the rule back in the one
    // place that cannot see a workspace.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.signInSocial.mockResolvedValue(undefined);

    render(<SignUpClient googleAuthConfigured={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Google" }));

    await waitFor(() => expect(mocks.signInSocial).toHaveBeenCalled());
    const arg = mocks.signInSocial.mock.calls[0][0] as { provider: string; callbackURL: string };
    expect(arg.provider).toBe("google");
    expect(arg.callbackURL.startsWith("/onboarding?")).toBe(true);
    expect(arg.callbackURL).toContain(
      `callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234")}`,
    );
  });

  it("ignores a non-device callback and onboards a new account directly", async () => {
    setParams({ callbackUrl: "/projects/p1/traces" });
    mocks.signUpEmail.mockResolvedValue({ error: null });

    render(<SignUpClient googleAuthConfigured={false} />);
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/onboarding"));
  });

  it("does not funnel a lookalike /device-prefixed path into the device flow", async () => {
    // Exact-path match: only /device (the consent page) is the device flow, not
    // a future route like /device-settings.
    setParams({ callbackUrl: "/device-settings" });
    mocks.signUpEmail.mockResolvedValue({ error: null });

    render(<SignUpClient googleAuthConfigured={false} />);
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/onboarding"));
  });

  it("carries the callback to the sign-in link", () => {
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });

    render(<SignUpClient googleAuthConfigured={false} />);
    const link = screen.getByRole("link", { name: "Sign in" });
    expect(link.getAttribute("href")).toBe(
      `/auth/sign-in?callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234")}`,
    );
  });

  it("uses a bare sign-in link when there is no callback", () => {
    render(<SignUpClient googleAuthConfigured={false} />);
    const link = screen.getByRole("link", { name: "Sign in" });
    expect(link.getAttribute("href")).toBe("/auth/sign-in");
  });
});
