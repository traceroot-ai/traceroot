// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { email: vi.fn(), social: vi.fn() }, signUp: { email: vi.fn() } },
}));

import type { SocialProvider } from "@/lib/social-providers";
import { SignInClient } from "./sign-in/sign-in-client";
import { SignUpClient } from "./sign-up/sign-up-client";

afterEach(cleanup);

const OPTIONS = ["Continue with GitHub", "Continue with Google", "Continue with AgentID"];

/** Each option's state on the page as rendered: missing, disabled or enabled. */
function optionStates() {
  return OPTIONS.map((name) => {
    const button = screen.queryByRole("button", { name }) as HTMLButtonElement | null;
    return button === null ? "missing" : button.disabled ? "disabled" : "enabled";
  });
}

describe("sign-in options on sign-in and sign-up", () => {
  it.each<[SocialProvider[], string[]]>([
    [[], ["disabled", "missing", "disabled"]],
    [["google"], ["disabled", "enabled", "disabled"]],
    [["agentid"], ["disabled", "missing", "enabled"]],
    [
      ["google", "agentid"],
      ["disabled", "enabled", "enabled"],
    ],
    [["github"], ["enabled", "missing", "disabled"]],
    [
      ["github", "google", "agentid"],
      ["enabled", "enabled", "enabled"],
    ],
  ])("match each other with %j configured", (socialProviders, expected) => {
    render(<SignUpClient socialProviders={socialProviders} emailDomainPolicyEnabled />);
    const signUp = optionStates();
    cleanup();
    render(<SignInClient socialProviders={socialProviders} />);
    expect(optionStates()).toEqual(signUp);
    expect(signUp).toEqual(expected);
  });
});
