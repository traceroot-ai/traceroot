// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ signInSocial: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { social: (...args: unknown[]) => mocks.signInSocial(...args) } },
}));

import { useSocialSignIn } from "./use-social-sign-in";

afterEach(() => {
  cleanup();
  mocks.signInSocial.mockReset();
});

describe("useSocialSignIn", () => {
  it("starts GitHub with the callback unchanged, a terminal's device page included", async () => {
    mocks.signInSocial.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() =>
      useSocialSignIn(["github", "google"], "/device?user_code=ABCD1234", vi.fn()),
    );
    act(() => result.current.signIn("github"));
    expect(mocks.signInSocial).toHaveBeenCalledWith({
      provider: "github",
      callbackURL: "/device?user_code=ABCD1234",
    });
    expect(result.current.redirectingTo).toBe("github");
  });

  it("gives every option back when the page is restored from the back/forward cache", async () => {
    // A redirect that started never comes back through the error path, so the
    // state is still set when Back restores the page as it was.
    mocks.signInSocial.mockResolvedValue({});
    const { result } = renderHook(() => useSocialSignIn(["github", "google"], "/", vi.fn()));
    act(() => result.current.signIn("google"));
    await waitFor(() => expect(mocks.signInSocial).toHaveBeenCalled());
    expect(result.current.redirectingTo).toBe("google");
    // An ordinary pageshow (not a restore) leaves it alone.
    act(() => void window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false })));
    expect(result.current.redirectingTo).toBe("google");
    act(() => void window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(result.current.redirectingTo).toBeNull();
  });

  it("stops listening for restores once unmounted", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useSocialSignIn(["google"], "/", vi.fn()));
    const listener = add.mock.calls.find(([type]) => type === "pageshow")?.[1];
    expect(listener).toBeDefined();
    unmount();
    expect(remove).toHaveBeenCalledWith("pageshow", listener);
    add.mockRestore();
    remove.mockRestore();
  });

  it("says why, and gives the options back, when a sign-in cannot start", async () => {
    mocks.signInSocial.mockResolvedValue({ error: { message: "" } });
    const onError = vi.fn();
    const { result } = renderHook(() => useSocialSignIn(["github"], "/", onError));
    act(() => result.current.signIn("github"));
    await waitFor(() =>
      expect(onError).toHaveBeenLastCalledWith("Could not start sign-in. Please try again."),
    );
    expect(result.current.redirectingTo).toBeNull();
  });
});
