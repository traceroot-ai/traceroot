// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  resetPassword: vi.fn(),
}));

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    resetPassword: (...args: unknown[]) => mocks.resetPassword(...args),
  },
}));

import { ResetPasswordClient } from "../reset-password-client";

function setParams(params: Record<string, string>) {
  searchParams = new URLSearchParams(params);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  searchParams = new URLSearchParams();
});

describe("ResetPasswordClient", () => {
  it("shows invalid/expired message when no token is present", () => {
    setParams({});
    render(<ResetPasswordClient />);

    expect(screen.getByText(/This password reset link is invalid or has expired/i)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Request a new link" });
    expect(link.getAttribute("href")).toBe("/auth/forgot-password");
  });

  it("shows invalid/expired message when error=INVALID_TOKEN is present", () => {
    setParams({ error: "INVALID_TOKEN" });
    render(<ResetPasswordClient />);

    expect(screen.getByText(/This password reset link is invalid or has expired/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Request a new link" })).toBeTruthy();
  });

  it("renders the password reset form when a token is provided", () => {
    setParams({ token: "valid-token" });
    render(<ResetPasswordClient />);

    expect(screen.getByRole("heading", { name: "Set new password" })).toBeTruthy();
    expect(screen.getByPlaceholderText("At least 8 characters")).toBeTruthy();
    expect(screen.getByPlaceholderText("Repeat new password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset password" })).toBeTruthy();
  });

  it("validates that passwords match", async () => {
    setParams({ token: "valid-token" });
    render(<ResetPasswordClient />);

    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
      target: { value: "password123" },
    });
    fireEvent.change(screen.getByPlaceholderText("Repeat new password"), {
      target: { value: "password456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByText("Passwords don't match")).toBeTruthy();
    expect(mocks.resetPassword).not.toHaveBeenCalled();
  });

  it("submits the new password and displays success screen", async () => {
    setParams({ token: "valid-token" });
    mocks.resetPassword.mockResolvedValue({ data: { status: true }, error: null });

    render(<ResetPasswordClient />);

    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
      target: { value: "newpassword123" },
    });
    fireEvent.change(screen.getByPlaceholderText("Repeat new password"), {
      target: { value: "newpassword123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    await waitFor(() =>
      expect(mocks.resetPassword).toHaveBeenCalledWith({
        newPassword: "newpassword123",
        token: "valid-token",
      }),
    );

    expect(await screen.findByText(/Your password has been successfully reset/i)).toBeTruthy();
    const signInLink = screen.getByRole("link", { name: "Sign in" });
    expect(signInLink.getAttribute("href")).toBe("/auth/sign-in");
  });

  it("displays error when resetPassword fails", async () => {
    setParams({ token: "valid-token" });
    mocks.resetPassword.mockResolvedValue({
      error: { message: "Token has expired" },
    });

    render(<ResetPasswordClient />);

    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
      target: { value: "newpassword123" },
    });
    fireEvent.change(screen.getByPlaceholderText("Repeat new password"), {
      target: { value: "newpassword123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByText("Token has expired")).toBeTruthy();
  });
});
