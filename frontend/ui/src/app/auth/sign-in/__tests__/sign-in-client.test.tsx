// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  signInEmail: vi.fn(),
  signInSocial: vi.fn(),
}));

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
  useSearchParams: () => searchParams,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: {
      email: (...args: unknown[]) => mocks.signInEmail(...args),
      social: (...args: unknown[]) => mocks.signInSocial(...args),
    },
  },
}));

import { SignInClient } from "../sign-in-client";
import { configuredSocialProviders } from "@/lib/social-providers";

function setParams(params: Record<string, string>) {
  searchParams = new URLSearchParams(params);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  searchParams = new URLSearchParams();
});

// The callback a signed-out visitor to an onboarding link arrives with: the
// path the proxy sent them from, carrying its own encoded callback to the
// `traceroot setup` run that is blocked waiting on them.
const NESTED_CALLBACK = "/onboarding?callbackUrl=%2Fdevice%3Fuser_code%3DABCD1234";

function fillAndSubmit() {
  fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
    target: { value: "kai@example.com" },
  });
  fireEvent.change(screen.getByPlaceholderText("********"), {
    target: { value: "password123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("SignInClient", () => {
  it("offers sign-up's options in its order: GitHub, Google, the form, then AgentID", () => {
    render(<SignInClient socialProviders={["google"]} />);
    const github = screen.getByRole("button", {
      name: "Continue with GitHub",
    }) as HTMLButtonElement;
    const google = screen.getByRole("button", {
      name: "Continue with Google",
    }) as HTMLButtonElement;
    const agentId = screen.getByRole("button", {
      name: "Continue with AgentID",
    }) as HTMLButtonElement;
    expect([github.disabled, google.disabled, agentId.disabled]).toEqual([true, false, true]);
    expect(screen.getByText(/Signing in as an AI agent\?/)).toBeTruthy();
    const order = [github, google, screen.getByRole("button", { name: "Sign in" }), agentId];
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("leaves Google out when it is not configured and keeps the email form", () => {
    render(<SignInClient socialProviders={[]} />);
    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
    expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("titles the card with the product name", () => {
    render(<SignInClient socialProviders={[]} />);
    expect(screen.getByRole("heading", { name: "Welcome back" })).toBeTruthy();
  });

  it("carries the callback to the sign-up link so a new user finishes the round-trip", () => {
    setParams({ callbackUrl: "/device?user_code=ABCD1234" });

    render(<SignInClient socialProviders={[]} />);
    const link = screen.getByRole("link", { name: "Sign up" });
    expect(link.getAttribute("href")).toBe(
      `/auth/sign-up?callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234")}`,
    );
  });

  it("uses a bare sign-up link when there is no callback", () => {
    render(<SignInClient socialProviders={[]} />);
    const link = screen.getByRole("link", { name: "Sign up" });
    expect(link.getAttribute("href")).toBe("/auth/sign-up");
  });

  it("returns the visitor to the full path, nested callback and all", async () => {
    setParams({ callbackUrl: NESTED_CALLBACK });
    mocks.signInEmail.mockResolvedValue({ error: null });

    render(<SignInClient socialProviders={[]} />);
    fillAndSubmit();

    // Unchanged, so the onboarding page still finds the terminal in its query.
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(NESTED_CALLBACK));
  });

  it("carries the nested callback through the Google round-trip", async () => {
    setParams({ callbackUrl: NESTED_CALLBACK });
    mocks.signInSocial.mockResolvedValue({ error: null });

    render(<SignInClient socialProviders={["google"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    await waitFor(() =>
      expect(mocks.signInSocial).toHaveBeenCalledWith({
        provider: "google",
        callbackURL: NESTED_CALLBACK,
      }),
    );
  });

  it("carries the nested callback to the sign-up link", () => {
    setParams({ callbackUrl: NESTED_CALLBACK });

    render(<SignInClient socialProviders={[]} />);
    const link = screen.getByRole("link", { name: "Sign up" });
    expect(link.getAttribute("href")).toBe(
      `/auth/sign-up?callbackUrl=${encodeURIComponent(NESTED_CALLBACK)}`,
    );
  });

  it("refuses a nested callback whose outer path is off-origin", async () => {
    setParams({ callbackUrl: "//evil.example/onboarding?callbackUrl=%2Fdevice" });
    mocks.signInEmail.mockResolvedValue({ error: null });

    render(<SignInClient socialProviders={[]} />);
    fillAndSubmit();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/"));
  });

  it("drops a foreign callback rather than forwarding it to sign-up", () => {
    setParams({ callbackUrl: "https://evil.example.com/steal" });

    render(<SignInClient socialProviders={[]} />);
    const link = screen.getByRole("link", { name: "Sign up" });
    // safeCallbackUrl collapses the off-origin value to the "/" fallback, which
    // is treated as "no real callback" — so the link stays bare.
    expect(link.getAttribute("href")).toBe("/auth/sign-up");
  });

  it("links Forgot? to the reset request page when email is set up", () => {
    render(<SignInClient socialProviders={[]} passwordResetEnabled />);
    expect(screen.getByRole("link", { name: "Forgot?" }).getAttribute("href")).toBe(
      "/auth/forgot-password",
    );
  });

  // Without SMTP the reset email cannot go out, so the link would be a dead end.
  it("hides Forgot? when email is not set up", () => {
    render(<SignInClient socialProviders={[]} />);
    expect(screen.queryByRole("link", { name: "Forgot?" })).toBeNull();
  });

  it("shows progress and blocks a second submit while signing in", async () => {
    mocks.signInEmail.mockReturnValue(new Promise(() => {}));
    render(<SignInClient socialProviders={[]} />);
    fillAndSubmit();
    const button = await screen.findByRole("button", { name: "Signing in..." });
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});

describe("SignInClient social sign-in", () => {
  const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

  it("enables AgentID under the Sign in button when it is configured", () => {
    render(<SignInClient socialProviders={["google", "agentid"]} />);
    expect([
      button("Continue with Google").disabled,
      button("Continue with AgentID").disabled,
    ]).toEqual([false, false]);
    expect(
      button("Sign in").compareDocumentPosition(button("Continue with AgentID")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("starts the AgentID round-trip with the callback and disables the other options", async () => {
    setParams({ callbackUrl: NESTED_CALLBACK });
    mocks.signInSocial.mockReturnValue(new Promise(() => {}));

    render(<SignInClient socialProviders={["google", "agentid"]} />);
    fireEvent.click(button("Continue with AgentID"));

    expect(mocks.signInSocial).toHaveBeenCalledWith({
      provider: "agentid",
      callbackURL: NESTED_CALLBACK,
    });
    expect(
      ((await screen.findByRole("button", { name: "Redirecting..." })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(button("Continue with Google").disabled).toBe(true);
  });

  it("gives every option back and shows why when the sign-in cannot start", async () => {
    mocks.signInSocial.mockResolvedValue({ error: { message: "Provider not found" } });

    render(<SignInClient socialProviders={["google", "agentid"]} />);
    fireEvent.click(button("Continue with AgentID"));

    expect(await screen.findByText("Provider not found")).toBeTruthy();
    expect(button("Continue with Google").disabled).toBe(false);
    expect(button("Continue with AgentID").disabled).toBe(false);
  });

  it("recovers the same way when the request itself fails", async () => {
    mocks.signInSocial.mockRejectedValue(new Error("network down"));

    render(<SignInClient socialProviders={["google", "agentid"]} />);
    fireEvent.click(button("Continue with Google"));

    expect(await screen.findByText("Could not start sign-in. Please try again.")).toBeTruthy();
    expect(button("Continue with Google").disabled).toBe(false);
  });
});

describe("configuredSocialProviders", () => {
  const unset = {
    AUTH_GITHUB_CLIENT_ID: "",
    AUTH_GITHUB_CLIENT_SECRET: "",
    AUTH_GOOGLE_CLIENT_ID: "",
    AUTH_GOOGLE_CLIENT_SECRET: "",
    AUTH_AGENTID_CLIENT_ID: "",
    AUTH_AGENTID_CLIENT_SECRET: "",
  };
  const google = { AUTH_GOOGLE_CLIENT_ID: "g", AUTH_GOOGLE_CLIENT_SECRET: "g" };
  const agentid = { AUTH_AGENTID_CLIENT_ID: "a", AUTH_AGENTID_CLIENT_SECRET: "a" };
  const github = { AUTH_GITHUB_CLIENT_ID: "h", AUTH_GITHUB_CLIENT_SECRET: "h" };

  it.each([
    ["none", {}, []],
    ["Google", google, ["google"]],
    ["Google with a blank secret", { ...google, AUTH_GOOGLE_CLIENT_SECRET: " " }, []],
    ["AgentID", agentid, ["agentid"]],
    ["AgentID with a blank secret", { ...agentid, AUTH_AGENTID_CLIENT_SECRET: " " }, []],
    ["both, Google first", { ...google, ...agentid }, ["google", "agentid"]],
    ["GitHub", github, ["github"]],
    ["GitHub with a blank secret", { ...github, AUTH_GITHUB_CLIENT_SECRET: " " }, []],
    [
      "all three, GitHub first",
      { ...github, ...google, ...agentid },
      ["github", "google", "agentid"],
    ],
  ])("%s", (_, env, expected) => {
    expect(configuredSocialProviders({ ...unset, ...env })).toEqual(expected);
  });
});
