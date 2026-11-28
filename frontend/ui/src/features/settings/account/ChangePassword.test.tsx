// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const changePassword = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-client", () => ({
  authClient: { changePassword: (...args: unknown[]) => changePassword(...args) },
}));

import { ChangePassword } from "./ChangePassword";

afterEach(() => {
  cleanup();
  changePassword.mockReset();
});

function fillPasswords(confirmPassword = "new-password-456") {
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "current-password-123" },
  });
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: "new-password-456" },
  });
  fireEvent.change(screen.getByLabelText("Confirm password"), {
    target: { value: confirmPassword },
  });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
}

describe("ChangePassword", () => {
  it("saves the password, reports the server count, clears credentials, and refreshes sessions", async () => {
    changePassword.mockResolvedValue({
      data: { otherSessionsBeforeChange: 3 },
      error: null,
    });
    const onChanged = vi.fn();
    render(<ChangePassword onChanged={onChanged} />);
    fillPasswords();
    submit();

    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledExactlyOnceWith({
        currentPassword: "current-password-123",
        newPassword: "new-password-456",
      }),
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("All other sessions have been signed out");
    expect(status.textContent).toContain("3 active before the change");
    for (const label of ["Current password", "New password", "Confirm password"]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe("");
    }
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("reports a zero count rather than hiding a successful change", async () => {
    changePassword.mockResolvedValue({
      data: { otherSessionsBeforeChange: 0 },
      error: null,
    });
    render(<ChangePassword onChanged={vi.fn()} />);
    fillPasswords();
    submit();

    expect((await screen.findByRole("status")).textContent).toContain("0 active before the change");
  });

  it("shows an API rejection without clearing the form or reporting success", async () => {
    changePassword.mockResolvedValue({
      data: null,
      error: { message: "Invalid current password" },
    });
    const onChanged = vi.fn();
    render(<ChangePassword onChanged={onChanged} />);
    fillPasswords();
    submit();

    expect((await screen.findByRole("alert")).textContent).toBe("Invalid current password");
    expect(screen.queryByRole("status")).toBeNull();
    expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe(
      "current-password-123",
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("provides a fallback when the API rejection has no message", async () => {
    changePassword.mockResolvedValue({ data: null, error: {} });
    render(<ChangePassword onChanged={vi.fn()} />);
    fillPasswords();
    submit();

    expect((await screen.findByRole("alert")).textContent).toBe("Could not change your password");
  });

  it("shows a connection error and allows a retry when the request fails", async () => {
    changePassword.mockRejectedValueOnce(new Error("Network unavailable"));
    const onChanged = vi.fn();
    render(<ChangePassword onChanged={onChanged} />);
    fillPasswords();
    submit();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not change your password. Check your connection and try again.",
    );
    expect(screen.getByRole("button", { name: "Change password" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();

    changePassword.mockResolvedValueOnce({ data: { otherSessionsBeforeChange: 1 }, error: null });
    submit();
    expect((await screen.findByRole("status")).textContent).toContain("1 active before the change");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatching confirmation before sending credentials", async () => {
    const onChanged = vi.fn();
    render(<ChangePassword onChanged={onChanged} />);
    fillPasswords("different-password");
    submit();

    expect(await screen.findByText("Passwords do not match")).toBeTruthy();
    expect(changePassword).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("disables submission while the change is pending to prevent duplicate requests", async () => {
    let complete!: (result: { data: { otherSessionsBeforeChange: number }; error: null }) => void;
    changePassword.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const onChanged = vi.fn();
    render(<ChangePassword onChanged={onChanged} />);
    fillPasswords();
    submit();

    const pending = await screen.findByRole("button", { name: "Changing password..." });
    expect(pending.hasAttribute("disabled")).toBe(true);
    fireEvent.click(pending);
    expect(changePassword).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();

    await act(async () => {
      complete({ data: { otherSessionsBeforeChange: 2 }, error: null });
    });
    expect((await screen.findByRole("status")).textContent).toContain("2 active before the change");
    expect(screen.getByRole("button", { name: "Change password" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
