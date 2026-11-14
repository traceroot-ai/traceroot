// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@/env", () => ({ env: {} }));

import { env } from "@/env";
import SignUpPage from "../page";

function setParams(params: Record<string, string>) {
  searchParams = new URLSearchParams(params);
}

function fillForm(email = "kai@acme.io") {
  fireEvent.change(screen.getByPlaceholderText("John Doe"), { target: { value: "Kai" } });
  fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
    target: { value: email },
  });
  const passwords = screen.getAllByPlaceholderText("********");
  fireEvent.change(passwords[0], { target: { value: "password123" } });
  fireEvent.change(passwords[1], { target: { value: "password123" } });
}

beforeEach(() => {
  env.TRACEROOT_CLOUD_ENV = undefined;
  env.AUTH_GOOGLE_CLIENT_ID = "";
  env.AUTH_GOOGLE_CLIENT_SECRET = "";
});

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
  mocks.refresh.mockReset();
  mocks.signUpEmail.mockReset();
  mocks.signInSocial.mockReset();
  searchParams = new URLSearchParams();
});

describe("SignUpPage", () => {
  it("shows a validation error and does not submit a signup without a name", async () => {
    render(<SignUpPage />);
    fillForm();
    fireEvent.change(screen.getByPlaceholderText("John Doe"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    expect(await screen.findByText("Name is required")).toBeTruthy();
    expect(mocks.signUpEmail).not.toHaveBeenCalled();
  });

  it("submits a test-domain signup and onboards outside TraceRoot Cloud", async () => {
    mocks.signUpEmail.mockResolvedValue({ error: null });

    render(<SignUpPage />);
    fillForm("kai@workspace.test");
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/onboarding"));
    expect(mocks.signUpEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "kai@workspace.test" }),
    );
  });

  it("routes a device-login signup through onboarding, carrying the device URL back", async () => {
    // Onboarding has to run before the device code is approved. Approving first
    // releases the waiting CLI, which immediately asks the account for a project
    // — and a brand-new account has no workspace to hold one until this form is
    // submitted.
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.signUpEmail.mockResolvedValue({ error: null });

    render(<SignUpPage />);
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

    env.AUTH_GOOGLE_CLIENT_ID = "test-client";
    env.AUTH_GOOGLE_CLIENT_SECRET = "test-secret";
    render(<SignUpPage />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

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

    render(<SignUpPage />);
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/onboarding"));
  });

  it("does not funnel a lookalike /device-prefixed path into the device flow", async () => {
    // Exact-path match: only /device (the consent page) is the device flow, not
    // a future route like /device-settings.
    setParams({ callbackUrl: "/device-settings" });
    mocks.signUpEmail.mockResolvedValue({ error: null });

    render(<SignUpPage />);
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/onboarding"));
  });

  it("carries the callback to the sign-in link", () => {
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });

    render(<SignUpPage />);
    const link = screen.getByRole("link", { name: "Sign in" });
    expect(link.getAttribute("href")).toBe(
      `/auth/sign-in?callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234")}`,
    );
  });

  it.each([
    ["production", "kai@example.com", "This email domain can't receive mail"],
    ["staging", "kai@mailinator.com", "Disposable email addresses aren't supported"],
  ] as const)("shows the %s rejection for %s inline", async (cloudEnv, email, message) => {
    env.TRACEROOT_CLOUD_ENV = cloudEnv;
    render(<SignUpPage />);
    fillForm(email);
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    expect(await screen.findByText(new RegExp(message))).toBeTruthy();
    expect(mocks.signUpEmail).not.toHaveBeenCalled();
  });

  it("uses a bare sign-in link when there is no callback", () => {
    render(<SignUpPage />);
    const link = screen.getByRole("link", { name: "Sign in" });
    expect(link.getAttribute("href")).toBe("/auth/sign-in");
  });

  it("shows progress and blocks a second submit while creating the account", async () => {
    mocks.signUpEmail.mockReturnValue(new Promise(() => {}));
    render(<SignUpPage />);
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
    const button = await screen.findByRole("button", { name: "Creating account..." });
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});
