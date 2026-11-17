// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  requestPasswordReset: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    requestPasswordReset: (...args: unknown[]) => mocks.requestPasswordReset(...args),
  },
}));

import { ForgotPasswordClient } from "../forgot-password-client";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ForgotPasswordClient", () => {
  it("renders the heading and description", () => {
    render(<ForgotPasswordClient />);
    expect(screen.getByRole("heading", { name: "Reset your password" })).toBeTruthy();
    expect(
      screen.getByText("Enter your email and we'll send you a link to reset your password."),
    ).toBeTruthy();
  });

  it("submits the email and shows confirmation on success", async () => {
    mocks.requestPasswordReset.mockResolvedValue({ data: { status: true }, error: null });

    render(<ForgotPasswordClient />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    await waitFor(() =>
      expect(mocks.requestPasswordReset).toHaveBeenCalledWith({
        email: "user@example.com",
        redirectTo: "/auth/reset-password",
      }),
    );

    expect(await screen.findByText(/If an account exists for/i)).toBeTruthy();
    expect(screen.getByText("user@example.com")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to sign in" })).toBeTruthy();
  });

  it("displays an error when requestPasswordReset fails", async () => {
    mocks.requestPasswordReset.mockResolvedValue({
      error: { message: "Rate limit exceeded" },
    });

    render(<ForgotPasswordClient />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText("Rate limit exceeded")).toBeTruthy();
  });

  it("renders a link back to sign-in page", () => {
    render(<ForgotPasswordClient />);
    const link = screen.getByRole("link", { name: "Sign in" });
    expect(link.getAttribute("href")).toBe("/auth/sign-in");
  });
});
