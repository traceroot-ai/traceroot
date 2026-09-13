// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

import { DeleteAlertDialog } from "./delete-alert-dialog";

afterEach(() => {
  cleanup();
});

const renderDialog = (overrides: { isOpen?: boolean; isDeleting?: boolean } = {}) => {
  const onClose = vi.fn();
  const onConfirm = vi.fn();

  render(
    <DeleteAlertDialog
      alertName="P95 latency"
      isOpen={overrides.isOpen ?? true}
      onClose={onClose}
      onConfirm={onConfirm}
      isDeleting={overrides.isDeleting}
    />,
  );

  return { onClose, onConfirm };
};

describe("DeleteAlertDialog", () => {
  it("names the alert and spells out what deleting costs", () => {
    renderDialog();

    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).toContain("P95 latency");
    expect(text).toContain("Evaluation and notifications stop immediately");
    expect(text).toContain("cannot be undone");
  });

  it("confirms once the alert's name is typed", () => {
    const { onConfirm } = renderDialog();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "P95 latency" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps Delete disabled until the typed name matches exactly", () => {
    renderDialog();

    const confirm = screen.getByRole("button", { name: "Delete" });
    const input = screen.getByRole("textbox");
    expect(confirm.hasAttribute("disabled")).toBe(true);

    fireEvent.change(input, { target: { value: "P95 laten" } });
    expect(confirm.hasAttribute("disabled")).toBe(true);

    fireEvent.change(input, { target: { value: "p95 latency" } });
    expect(confirm.hasAttribute("disabled")).toBe(true);

    fireEvent.change(input, { target: { value: "P95 latency" } });
    expect(confirm.hasAttribute("disabled")).toBe(false);
  });

  it("opens with Delete disabled and focus in the confirmation input, so a stray Enter does not delete", () => {
    renderDialog();

    expect(document.activeElement).toBe(screen.getByRole("textbox"));
    expect(screen.getByRole("button", { name: "Delete" }).hasAttribute("disabled")).toBe(true);
  });

  it("closes without deleting when cancelled", () => {
    const { onClose, onConfirm } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("blocks a second confirm while the delete is in flight", () => {
    renderDialog({ isDeleting: true });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "P95 latency" } });

    const confirm = screen.getByRole("button", { name: "Deleting..." });
    expect(confirm.hasAttribute("disabled")).toBe(true);
  });

  it("renders nothing while closed", () => {
    renderDialog({ isOpen: false });

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
