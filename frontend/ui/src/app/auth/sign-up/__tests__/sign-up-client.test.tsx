// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  signUpEmail: vi.fn(),
  signInSocial: vi.fn(),
  captureAttribution: vi.fn(),
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

vi.mock("@/lib/marketing-attribution-browser", () => ({
  captureBrowserAttribution: mocks.captureAttribution,
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
  mocks.captureAttribution.mockReset();
  searchParams = new URLSearchParams();
});

describe("SignUpClient", () => {
  it("sends a normal signup straight to onboarding", async () => {
    mocks.signUpEmail.mockResolvedValue({ error: null });

    render(<SignUpClient googleAuthConfigured={false} />);
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/onboarding"));
    expect(mocks.captureAttribution).toHaveBeenCalledOnce();
    expect(mocks.captureAttribution.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.signUpEmail.mock.invocationCallOrder[0],
    );
  });

  it("still creates the account when analytics opt-out prevents attribution capture", async () => {
    mocks.captureAttribution.mockReturnValue(null);
    mocks.signUpEmail.mockResolvedValue({ error: null });
    render(<SignUpClient googleAuthConfigured={false} />);
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/onboarding"));
    expect(mocks.signUpEmail).toHaveBeenCalledWith({
      name: "Kai",
      email: "kai@example.com",
      password: "password123",
    });
  });

  it("routes a device-login signup through /device with a next=onboarding hint", async () => {
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.signUpEmail.mockResolvedValue({ error: null });

    render(<SignUpClient googleAuthConfigured={false} />);
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalled());
    const dest = mocks.push.mock.calls[0][0] as string;
    expect(dest.startsWith("/device?")).toBe(true);
    expect(dest).toContain("user_code=ABCD1234");
    expect(dest).toContain(`next=${encodeURIComponent("/onboarding")}`);
  });

  it("passes the same device destination to Google sign-up", async () => {
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.signInSocial.mockResolvedValue(undefined);

    render(<SignUpClient googleAuthConfigured={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Google" }));

    await waitFor(() => expect(mocks.signInSocial).toHaveBeenCalled());
    const arg = mocks.signInSocial.mock.calls[0][0] as { provider: string; callbackURL: string };
    expect(arg.provider).toBe("google");
    expect(arg.callbackURL.startsWith("/device?")).toBe(true);
    expect(arg.callbackURL).toContain(`next=${encodeURIComponent("/onboarding")}`);
    expect(mocks.captureAttribution).toHaveBeenCalledOnce();
    expect(mocks.captureAttribution.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.signInSocial.mock.invocationCallOrder[0],
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

  it("keeps the campaign when returning to sign-in but rejects a foreign callback", () => {
    setParams({
      callbackUrl: "https://evil.example.com/steal",
      utm_source: "github",
      utm_campaign: "github-navigation",
      token: "private-token",
    });
    render(<SignUpClient googleAuthConfigured={false} />);

    const href = screen.getByRole("link", { name: "Sign in" }).getAttribute("href")!;
    const target = new URL(href, "http://localhost");
    expect(Object.fromEntries(target.searchParams)).toEqual({
      utm_source: "github",
      utm_campaign: "github-navigation",
    });
  });
});
