// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const requestPasswordReset = vi.hoisted(() => vi.fn());
const resetPassword = vi.hoisted(() => vi.fn());
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({ useSearchParams: () => searchParams }));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    requestPasswordReset: (...args: unknown[]) => requestPasswordReset(...args),
    resetPassword: (...args: unknown[]) => resetPassword(...args),
  },
}));

import { ForgotPasswordClient } from "../forgot-password/forgot-password-client";
import { ResetPasswordClient } from "../reset-password/reset-password-client";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  searchParams = new URLSearchParams();
});

function submit(email: string) {
  fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
}

function fill(password: string, confirm: string) {
  const [first, second] = screen.getAllByPlaceholderText("********");
  fireEvent.change(first!, { target: { value: password } });
  fireEvent.change(second!, { target: { value: confirm } });
  fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
}

describe("ForgotPasswordClient", () => {
  it("asks better-auth to send a link that lands on the reset page", async () => {
    requestPasswordReset.mockResolvedValue({ error: null });
    render(<ForgotPasswordClient />);
    submit("a@example.com");
    await waitFor(() =>
      expect(requestPasswordReset).toHaveBeenCalledWith({
        email: "a@example.com",
        redirectTo: "/auth/reset-password",
      }),
    );
  });

  // The same message for every address, so the page never reveals who has an account.
  it("confirms without saying whether the account exists", async () => {
    requestPasswordReset.mockResolvedValue({ error: null });
    render(<ForgotPasswordClient />);
    submit("a@example.com");
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeTruthy();
    expect(screen.getByText(/If an account exists for a@example.com/)).toBeTruthy();
  });

  it("shows the server error and stays on the form", async () => {
    requestPasswordReset.mockResolvedValue({ error: { message: "Too many requests" } });
    render(<ForgotPasswordClient />);
    submit("a@example.com");
    expect(await screen.findByText("Too many requests")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeTruthy();
  });

  it("rejects an invalid email before calling the server", async () => {
    render(<ForgotPasswordClient />);
    // Passes the browser's type="email" check, so the schema is what rejects it.
    submit("a@b");
    expect(await screen.findByText("Invalid email")).toBeTruthy();
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });
});

describe("ResetPasswordClient", () => {
  it("offers a new link when better-auth rejected the token", () => {
    searchParams = new URLSearchParams({ error: "INVALID_TOKEN" });
    render(<ResetPasswordClient />);
    expect(screen.getByRole("heading", { name: "This link has expired" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Request a new link" }).getAttribute("href")).toBe(
      "/auth/forgot-password",
    );
  });

  it("saves the new password with the token from the link", async () => {
    searchParams = new URLSearchParams({ token: "tok123" });
    resetPassword.mockResolvedValue({ error: null });
    render(<ResetPasswordClient />);
    fill("new-password", "new-password");
    await waitFor(() =>
      expect(resetPassword).toHaveBeenCalledWith({ newPassword: "new-password", token: "tok123" }),
    );
    expect(await screen.findByRole("heading", { name: "Password updated" })).toBeTruthy();
  });

  it("does not submit when the passwords differ", async () => {
    searchParams = new URLSearchParams({ token: "tok123" });
    render(<ResetPasswordClient />);
    fill("new-password", "other-password");
    expect(await screen.findByText("Passwords do not match")).toBeTruthy();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("offers a new link when the token is rejected on submit, e.g. used twice", async () => {
    searchParams = new URLSearchParams({ token: "tok123" });
    resetPassword.mockResolvedValue({ error: { code: "INVALID_TOKEN", message: "Invalid token" } });
    render(<ResetPasswordClient />);
    fill("new-password", "new-password");
    expect(await screen.findByRole("heading", { name: "This link has expired" })).toBeTruthy();
  });

  it("shows any other server error on the form", async () => {
    searchParams = new URLSearchParams({ token: "tok123" });
    resetPassword.mockResolvedValue({ error: { message: "Password too long" } });
    render(<ResetPasswordClient />);
    fill("new-password", "new-password");
    expect((await screen.findByRole("alert")).textContent).toBe("Password too long");
  });
});
