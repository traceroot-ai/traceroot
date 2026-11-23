// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const m = vi.hoisted(() => ({ push: vi.fn(), signOut: vi.fn(), order: [] as string[] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push }) }));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: m.signOut } }));

import { onboardingSignInUrl, useSwitchAccount } from "./use-switch-account";

afterEach(() => {
  m.push.mockReset();
  m.signOut.mockReset();
  m.order = [];
});

/** Where a sign-in started from `pushed` comes back to, and what it carries. */
function roundTrip(pushed: string) {
  const signIn = new URL(pushed, "http://x");
  const back = new URL(signIn.searchParams.get("callbackUrl")!, "http://x");
  return {
    signIn: signIn.pathname,
    back: back.pathname,
    handBack: back.searchParams.get("callbackUrl"),
  };
}

describe("switching account", () => {
  it("lets the answers still being saved land first, then signs out", async () => {
    let finishSave!: () => void;
    const saving = new Promise<void>((resolve) => (finishSave = resolve)).then(() =>
      m.order.push("saved"),
    );
    m.signOut.mockImplementation(async () => {
      m.order.push("signed out");
      return { error: null };
    });
    const { result } = renderHook(() => useSwitchAccount(null));

    let done!: Promise<void>;
    act(() => {
      done = result.current.switchAccount(saving);
    });
    await Promise.resolve();
    expect(m.signOut).not.toHaveBeenCalled();
    finishSave();
    await act(() => done);

    expect(m.order).toEqual(["saved", "signed out"]);
    expect(m.push).toHaveBeenCalledWith("/auth/sign-in?callbackUrl=%2Fonboarding");
  });

  it("signs out even when a save failed", async () => {
    m.signOut.mockResolvedValue({ error: null });
    const { result } = renderHook(() => useSwitchAccount(null));
    await act(() => result.current.switchAccount(Promise.reject(new Error("down"))));
    expect(m.signOut).toHaveBeenCalled();
  });

  it("keeps a waiting terminal's hand-back through sign-in", async () => {
    m.signOut.mockResolvedValue({ error: null });
    const { result } = renderHook(() => useSwitchAccount("/device?user_code=ABCD1234"));
    await act(() => result.current.switchAccount());

    expect(roundTrip(m.push.mock.calls[0][0])).toEqual({
      signIn: "/auth/sign-in",
      back: "/onboarding",
      handBack: "/device?user_code=ABCD1234",
    });
    expect(m.push.mock.calls[0][0]).toBe(onboardingSignInUrl("/device?user_code=ABCD1234"));
  });

  it.each([
    ["refused", () => m.signOut.mockResolvedValue({ error: { status: 429 } })],
    ["thrown", () => m.signOut.mockRejectedValue(new Error("network"))],
  ])("stays, and says so, when the sign-out is %s", async (_how, arrange) => {
    arrange();
    const { result } = renderHook(() => useSwitchAccount(null));
    await act(() => result.current.switchAccount());

    expect(m.push).not.toHaveBeenCalled();
    expect(result.current.error).toBe("Could not sign out. Please try again.");
    expect(result.current.switching).toBe(false);
  });
});
