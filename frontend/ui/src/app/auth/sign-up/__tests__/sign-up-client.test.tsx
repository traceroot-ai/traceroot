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
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Kai" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
}

beforeEach(() => {
  env.TRACEROOT_CLOUD_ENV = undefined;
  env.AUTH_GOOGLE_CLIENT_ID = "";
  env.AUTH_GOOGLE_CLIENT_SECRET = "";
  env.AUTH_AGENTID_CLIENT_ID = "";
  env.AUTH_AGENTID_CLIENT_SECRET = "";
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
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    expect(await screen.findByText("Name is required")).toBeTruthy();
    expect(mocks.signUpEmail).not.toHaveBeenCalled();
  });

  it("asks for the password once and sends it with the name and email", async () => {
    mocks.signUpEmail.mockResolvedValue({ error: null });

    render(<SignUpPage />);
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1);
    fillForm("kai@workspace.test");
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    await waitFor(() => expect(mocks.signUpEmail).toHaveBeenCalled());
    expect(mocks.signUpEmail).toHaveBeenCalledWith({
      name: "Kai",
      email: "kai@workspace.test",
      password: "password123",
    });
  });

  it("rejects a password shorter than 8 characters", async () => {
    render(<SignUpPage />);
    fillForm("kai@workspace.test");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));

    expect(await screen.findByText("Password must be at least 8 characters")).toBeTruthy();
    expect(mocks.signUpEmail).not.toHaveBeenCalled();
  });

  it("shows GitHub disabled, and AgentID disabled until its client is configured", () => {
    render(<SignUpPage />);
    expect(
      (screen.getByRole("button", { name: "Continue with GitHub" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Continue with AgentID" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Signing up an AI agent\?/)).toBeTruthy();
    // Google keeps its existing rule: shown only when its client is configured.
    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
  });

  it("orders GitHub, then Google, then the form, then AgentID, as in the design", () => {
    env.AUTH_GOOGLE_CLIENT_ID = "test-client";
    env.AUTH_GOOGLE_CLIENT_SECRET = "test-secret";
    render(<SignUpPage />);
    const google = screen.getByRole("button", {
      name: "Continue with Google",
    }) as HTMLButtonElement;
    expect(google.disabled).toBe(false);
    const order = [
      screen.getByRole("button", { name: "Continue with GitHub" }),
      google,
      screen.getByRole("button", { name: "Sign up" }),
      screen.getByRole("button", { name: "Continue with AgentID" }),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
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

describe("SignUpPage social buttons", () => {
  it("sends an AgentID sign-up to the same onboarding destination as Google", async () => {
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });
    mocks.signInSocial.mockReturnValue(new Promise(() => {}));

    env.AUTH_GOOGLE_CLIENT_ID = "test-client";
    env.AUTH_GOOGLE_CLIENT_SECRET = "test-secret";
    env.AUTH_AGENTID_CLIENT_ID = "agentid-client";
    env.AUTH_AGENTID_CLIENT_SECRET = "agentid-secret";
    render(<SignUpPage />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with AgentID" }));

    const arg = mocks.signInSocial.mock.calls[0][0] as { provider: string; callbackURL: string };
    expect(arg.provider).toBe("agentid");
    expect(arg.callbackURL).toBe(
      `/onboarding?callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234")}`,
    );
    expect(
      (screen.getByRole("button", { name: "Continue with Google" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
