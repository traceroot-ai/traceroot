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
  searchParams = new URLSearchParams();
});

describe("DeviceClient", () => {
  it("pre-fills the code entry input from ?user_code", () => {
    setParams({ user_code: "abcd1234" });
    signedOut();

    render(<DeviceClient />);

    const input = screen.getByLabelText("Device code") as HTMLInputElement;
    expect(input.value).toBe("ABCD-1234");
  });

  it("shows an empty entry field when no code is present", () => {
    signedOut();

    render(<DeviceClient />);

    const input = screen.getByLabelText("Device code") as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("redirects to sign-in with the code preserved in callbackUrl when signed out", async () => {
    setParams({ user_code: "abcd1234" });
    signedOut();

    render(<DeviceClient />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalled());
    const target = mocks.push.mock.calls[0][0] as string;
    expect(target).toBe(
      `/auth/sign-in?callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234")}`,
    );
  });

  it("renders the client display name and the signed-in email on consent", async () => {
    setParams({ user_code: "abcd1234", client_id: "traceroot-cli" });
    signedIn("kai@example.com");
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "pending" },
      error: null,
    });

    render(<DeviceClient />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(screen.getByText("TraceRoot CLI")).toBeDefined());
    expect(screen.getByText("as kai@example.com")).toBeDefined();
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
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByText("Approved")).toBeDefined());
    expect(mocks.device.approve).toHaveBeenCalledWith({ userCode: "ABCD1234" });
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
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "This code isn't associated with your account, so it can't be approved or denied from here.",
        ),
      ).toBeDefined(),
    );
    expect(screen.queryByText("Approved")).toBeNull();
  });

  it("shows a mapped message for an expired code", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: null,
      error: { error: "expired_token", error_description: "User code has expired" },
    });

    render(<DeviceClient />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "This code has expired. Go back to your terminal and run the login command again.",
        ),
      ).toBeDefined(),
    );
  });

  it("shows a mapped message for an invalid code", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: null,
      error: { error: "invalid_request", error_description: "Invalid user code" },
    });

    render(<DeviceClient />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "That code doesn't match a pending request. Double-check it and try again.",
        ),
      ).toBeDefined(),
    );
  });

  it("shows an already-used message when the code has already been claimed", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: { user_code: "ABCD1234", status: "approved" },
      error: null,
    });

    render(<DeviceClient />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
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

  it("returns to the entry form from an error state via Try again", async () => {
    setParams({ user_code: "abcd1234" });
    signedIn();
    mocks.device.mockResolvedValue({
      data: null,
      error: { error: "expired_token", error_description: "User code has expired" },
    });

    render(<DeviceClient />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    const input = screen.getByLabelText("Device code") as HTMLInputElement;
    expect(input.value).toBe("");
  });
});
