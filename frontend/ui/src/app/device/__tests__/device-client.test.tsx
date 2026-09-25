// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

// The mocked `device` call must carry its `.approve`/`.deny` sub-mocks from
// the moment it's created — vi.mock's factory below runs at import time
// (before any later top-level statement in this file), so reassigning
// `mocks.device` afterwards would be invisible to it.
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  useSession: vi.fn(),
  signOut: vi.fn(),
  device: Object.assign(vi.fn(), { approve: vi.fn(), deny: vi.fn() }),
}));

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => searchParams,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => mocks.useSession(),
    signOut: (...args: unknown[]) => mocks.signOut(...args),
    device: mocks.device,
  },
}));

import { DeviceClient } from "../device-client";

function setParams(params: Record<string, string>) {
  searchParams = new URLSearchParams(params);
}

function signedIn(email = "kai@example.com") {
  mocks.useSession.mockReturnValue({
    data: { user: { email, name: "Kai" } },
    isPending: false,
  });
}

function signedOut() {
  mocks.useSession.mockReturnValue({ data: null, isPending: false });
}

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
  mocks.useSession.mockReset();
  mocks.device.mockReset();
  mocks.device.approve.mockReset();
  mocks.device.deny.mockReset();
  mocks.signOut.mockReset();
  searchParams = new URLSearchParams();
});

describe("DeviceClient", () => {
  it("auto-redirects to sign-in with the code in callbackUrl when signed out (no Continue)", async () => {
    setParams({ user_code: "abcd1234" });
    signedOut();

    render(<DeviceClient />);

    // A code in the URL advances on its own — no manual Continue to reach login.
    await waitFor(() => expect(mocks.push).toHaveBeenCalled());
    const target = mocks.push.mock.calls[0][0] as string;
    expect(target).toBe(
      `/auth/sign-in?callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234")}`,
    );
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("carries client_id through the signed-out redirect so consent still names the client", async () => {
    setParams({ user_code: "abcd1234", client_id: "traceroot-cli" });
    signedOut();

    render(<DeviceClient />);

    await waitFor(() => expect(mocks.push).toHaveBeenCalled());
    const target = mocks.push.mock.calls[0][0] as string;
    expect(target).toBe(
      `/auth/sign-in?callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234&client_id=traceroot-cli")}`,
    );
  });

  it("carries the onboarding `next` through the signed-out redirect (new-user device signup)", async () => {
    setParams({ user_code: "abcd1234", client_id: "traceroot-cli", next: "/onboarding" });
    signedOut();

    render(<DeviceClient />);

    await waitFor(() => expect(mocks.push).toHaveBeenCalled());
    const target = mocks.push.mock.calls[0][0] as string;
    // next must survive the sign-in round trip or a new account signing up
    // through the device flow never continues to onboarding.
    expect(target).toBe(
      `/auth/sign-in?callbackUrl=${encodeURIComponent(
        "/device?user_code=ABCD1234&client_id=traceroot-cli&next=%2Fonboarding",
      )}`,
    );
  });

  it("auto-advances to consent when signed in with a code in the URL (no Continue)", async () => {
    setParams({ user_code: "abcd1234", client_id: "traceroot-cli" });
    signedIn("kai@example.com");
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });

    render(<DeviceClient />);

    await waitFor(() => expect(screen.getByText("TraceRoot CLI")).toBeDefined());
    expect(screen.getByText("as kai@example.com")).toBeDefined();
    expect(screen.getByText("ABCD-1234")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("shows the entry form for a bare visit with no code in the URL", () => {
    signedOut();

    render(<DeviceClient />);

    const input = screen.getByLabelText("Device code") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDefined();
  });

  it("advances from a manually entered code when the URL has none", async () => {
    signedIn("kai@example.com");
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });

    render(<DeviceClient />);
    const input = screen.getByLabelText("Device code");
    fireEvent.change(input, { target: { value: "abcd1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(screen.getByText("as kai@example.com")).toBeDefined());
    expect(screen.getByText("ABCD-1234")).toBeDefined();
  });

  it("falls back to a generic name for an unrecognized client id", async () => {
    setParams({ user_code: "abcd1234", client_id: "some-other-app" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });

    render(<DeviceClient />);

    await waitFor(() => expect(screen.getByText("A command-line application")).toBeDefined());
  });

  it("approves with the hyphen-stripped code and shows the success state", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });
    mocks.device.approve.mockResolvedValue({ data: { success: true }, error: null });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByText("Approved")).toBeDefined());
    expect(mocks.device.approve).toHaveBeenCalledWith({ userCode: "ABCD1234" });
  });

  it("hands off to ?next after approve instead of the terminal screen (signup path)", async () => {
    setParams({ user_code: "abcd1234", next: "/onboarding" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });
    mocks.device.approve.mockResolvedValue({ data: { success: true }, error: null });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/onboarding"));
    expect(screen.queryByText("Approved")).toBeNull();
  });

  it("denies and shows the denied state", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });
    mocks.device.deny.mockResolvedValue({ data: { success: true }, error: null });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() => expect(screen.getByText("Denied")).toBeDefined());
    expect(mocks.device.deny).toHaveBeenCalledWith({ userCode: "ABCD1234" });
  });

  it("surfaces an error instead of success when approval is rejected (not the claiming session)", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });
    mocks.device.approve.mockResolvedValue({
      data: null,
      error: {
        error: "access_denied",
        error_description: "You are not authorized to approve this device authorization",
      },
    });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "This code was already opened by a different account and is locked to it. Go back to your terminal and run the login command again to get a fresh code.",
        ),
      ).toBeDefined(),
    );
    expect(screen.queryByText("Approved")).toBeNull();
    // Terminal error: no looping "Try again" — the code is dead, they need a new one.
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows a mapped message for an expired code (surfaced when approving)", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    // The claim is deferred to the action, so the expired error appears on Approve.
    mocks.device.mockResolvedValue({
      data: null,
      error: { error: "expired_token", error_description: "User code has expired" },
    });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "This code has expired. Go back to your terminal and run the login command again.",
        ),
      ).toBeDefined(),
    );
  });

  it("shows a mapped message for an invalid code (surfaced when approving)", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: null,
      error: { error: "invalid_request", error_description: "Invalid user code" },
    });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "That code doesn't match a pending request. Double-check it and try again.",
        ),
      ).toBeDefined(),
    );
  });

  it("shows an already-used message when the code has already been claimed (on approve)", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "approved" },
      error: null,
    });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByText("This code has already been used.")).toBeDefined());
  });

  it("shows an entry error instead of submitting when the code field is empty", () => {
    signedOut();

    render(<DeviceClient />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Enter the code shown in your terminal.")).toBeDefined();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("surfaces an error instead of the denied state when denial is rejected", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });
    mocks.device.deny.mockResolvedValue({
      data: null,
      error: { error: "expired_token", error_description: "User code has expired" },
    });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "This code has expired. Go back to your terminal and run the login command again.",
        ),
      ).toBeDefined(),
    );
    expect(screen.queryByText("Denied")).toBeNull();
  });

  it("offers Try again for a mistyped code and returns to the entry form (on approve)", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: null,
      error: { error: "invalid_request", error_description: "Invalid user code" },
    });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    const input = screen.getByLabelText("Device code") as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("shows no Try again for an expired code (terminal — needs a fresh code, on approve)", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: null,
      error: { error: "expired_token", error_description: "User code has expired" },
    });

    render(<DeviceClient />);
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "This code has expired. Go back to your terminal and run the login command again.",
        ),
      ).toBeDefined(),
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("does not claim the code on load — no verify call until the user acts", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();

    render(<DeviceClient />);
    // Consent shows without a verify/claim round-trip...
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    expect(mocks.device).not.toHaveBeenCalled();
  });

  it("signs out and returns to sign-in carrying the code from the consent 'Not you?' action", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn("wrong@example.com");
    mocks.signOut.mockResolvedValue(undefined);

    render(<DeviceClient />);
    await waitFor(() => screen.getByText("as wrong@example.com"));
    fireEvent.click(screen.getByRole("button", { name: "Not you? Sign out" }));

    await waitFor(() => expect(mocks.signOut).toHaveBeenCalled());
    // Code isn't claimed until the user acts, so it survives the account switch:
    // carry it back via callbackUrl so the new account lands on consent.
    expect(mocks.push).toHaveBeenCalledWith(
      `/auth/sign-in?callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234")}`,
    );
  });
});
