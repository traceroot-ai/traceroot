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

// Where the OAuth provider sends a signed-out user who is connecting an assistant.
const OAUTH_CALLBACK =
  "/oauth/continue?response_type=code&client_id=https%3A%2F%2Fclaude.ai%2Fdoc&sig=abc";

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
  it("titles the card with the product name", () => {
    render(<SignInClient socialProviders={[]} />);
    expect(screen.getByRole("heading", { name: "Sign in to traceroot" })).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Google" }));

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

  it("shows which assistant the sign-in will connect", () => {
    setParams({ callbackUrl: OAUTH_CALLBACK });

    render(
      <SignInClient
        socialProviders={[]}
        connection={{ name: "Claude", verifiedHost: "claude.ai" }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Sign in to connect Claude" })).toBeTruthy();
    expect(screen.getByText("claude.ai").parentElement?.textContent).toBe("Verified by claude.ai");
    expect(screen.queryByRole("alert")).toBeNull();
    // The connection is carried to sign-up too.
    expect(screen.getByRole("link", { name: "Sign up" }).getAttribute("href")).toBe(
      `/auth/sign-up?callbackUrl=${encodeURIComponent(OAUTH_CALLBACK)}`,
    );
  });

  it("marks a self-registered assistant as unverified while signing in", () => {
    setParams({ callbackUrl: OAUTH_CALLBACK });

    render(
      <SignInClient
        socialProviders={[]}
        connection={{ name: "Acme Helper", verifiedHost: null }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Sign in to connect Acme Helper" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Unverified application");
    expect(screen.queryByText(/Verified by/)).toBeNull();
  });

  it("returns to the authorization after signing in", async () => {
    setParams({ callbackUrl: OAUTH_CALLBACK });
    mocks.signInEmail.mockResolvedValue({ error: null });

    render(
      <SignInClient
        socialProviders={[]}
        connection={{ name: "Claude", verifiedHost: "claude.ai" }}
      />,
    );
    fillAndSubmit();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(OAUTH_CALLBACK));
  });
});

describe("SignInClient social buttons", () => {
  it("splits the row in half when both Google and AgentID are configured", () => {
    render(<SignInClient socialProviders={["google", "agentid"]} />);
    const google = screen.getByRole("button", { name: "Google" });
    const agentid = screen.getByRole("button", { name: "AgentID" });
    // Same row, Google first: one shared two-column grid.
    expect(google.parentElement).toBe(agentid.parentElement);
    expect(google.parentElement?.className).toContain("grid-cols-2");
    expect(google.compareDocumentPosition(agentid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps a lone provider full width", () => {
    render(<SignInClient socialProviders={["agentid"]} />);
    const agentid = screen.getByRole("button", { name: "AgentID" });
    expect(screen.queryByRole("button", { name: "Google" })).toBeNull();
    expect(agentid.parentElement?.className).not.toContain("grid-cols-2");
  });

  it("shows no divider when neither provider is configured", () => {
    render(<SignInClient socialProviders={[]} />);
    expect(screen.queryByText("Or continue with")).toBeNull();
  });

  it("starts the AgentID round-trip with the callback and disables both buttons", async () => {
    setParams({ callbackUrl: NESTED_CALLBACK });
    mocks.signInSocial.mockReturnValue(new Promise(() => {}));

    render(<SignInClient socialProviders={["google", "agentid"]} />);
    fireEvent.click(screen.getByRole("button", { name: "AgentID" }));

    expect(mocks.signInSocial).toHaveBeenCalledWith({
      provider: "agentid",
      callbackURL: NESTED_CALLBACK,
    });
    const redirecting = await screen.findByRole("button", { name: "Redirecting..." });
    expect((redirecting as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Google" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("gives both buttons back and shows why when the sign-in cannot start", async () => {
    mocks.signInSocial.mockResolvedValue({ error: { message: "Provider not found" } });

    render(<SignInClient socialProviders={["google", "agentid"]} />);
    fireEvent.click(screen.getByRole("button", { name: "AgentID" }));

    expect(await screen.findByText("Provider not found")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Google" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByRole("button", { name: "AgentID" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("recovers the same way when the request itself fails", async () => {
    mocks.signInSocial.mockRejectedValue(new Error("network down"));

    render(<SignInClient socialProviders={["google", "agentid"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Google" }));

    expect(await screen.findByText("Could not start sign-in. Please try again.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Google" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("SignInClient social buttons while connecting an assistant", () => {
  it.each(["google", "agentid"] as const)(
    "sends a %s sign-in back to the authorization",
    (provider) => {
      setParams({ callbackUrl: OAUTH_CALLBACK });
      mocks.signInSocial.mockReturnValue(new Promise(() => {}));

      render(
        <SignInClient
          socialProviders={["google", "agentid"]}
          connection={{ name: "Claude", verifiedHost: "claude.ai" }}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: provider === "google" ? "Google" : "AgentID" }),
      );

      expect(mocks.signInSocial).toHaveBeenCalledWith({ provider, callbackURL: OAUTH_CALLBACK });
    },
  );
});

describe("configuredSocialProviders", () => {
  const unset = {
    AUTH_GOOGLE_CLIENT_ID: "",
    AUTH_GOOGLE_CLIENT_SECRET: "",
    AUTH_AGENTID_CLIENT_ID: "",
    AUTH_AGENTID_CLIENT_SECRET: "",
  };
  const google = { AUTH_GOOGLE_CLIENT_ID: "g", AUTH_GOOGLE_CLIENT_SECRET: "g" };
  const agentid = { AUTH_AGENTID_CLIENT_ID: "a", AUTH_AGENTID_CLIENT_SECRET: "a" };

  it.each([
    ["none", {}, []],
    ["Google", google, ["google"]],
    ["Google with a blank secret", { ...google, AUTH_GOOGLE_CLIENT_SECRET: " " }, []],
    ["AgentID", agentid, ["agentid"]],
    ["AgentID with a blank secret", { ...agentid, AUTH_AGENTID_CLIENT_SECRET: " " }, []],
    ["both, Google first", { ...google, ...agentid }, ["google", "agentid"]],
  ])("%s", (_, env, expected) => {
    expect(configuredSocialProviders({ ...unset, ...env })).toEqual(expected);
  });
});
