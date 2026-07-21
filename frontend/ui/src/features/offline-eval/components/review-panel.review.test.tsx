// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ReviewPanel, type ReviewTarget } from "./review-panel";
import { ToastProvider } from "@/components/ui/toast";

afterEach(() => cleanup());

function baseTarget(overrides: Partial<ReviewTarget> = {}): ReviewTarget {
  return {
    targetKey: "result-1",
    contextLabel: "case-1 · eval v1",
    input: "input",
    output: "output",
    expected: null,
    autoScores: [],
    existing: undefined,
    ...overrides,
  };
}

describe("ReviewPanel", () => {
  it("does not reset the form when the parent re-renders with a new target object of the same identity", () => {
    const onSave = vi.fn();
    const { rerender } = render(
      <ToastProvider>
        <ReviewPanel target={baseTarget()} open onOpenChange={vi.fn()} onSave={onSave} />
      </ToastProvider>,
    );

    const comment = screen.getByLabelText(/comment/i) as HTMLInputElement;
    fireEvent.change(comment, { target: { value: "in progress notes" } });
    expect(comment.value).toBe("in progress notes");

    // Same targetKey, but a brand-new object literal — simulates the parent
    // re-rendering (e.g. a background refetch) and rebuilding `target` inline.
    rerender(
      <ToastProvider>
        <ReviewPanel target={baseTarget()} open onOpenChange={vi.fn()} onSave={onSave} />
      </ToastProvider>,
    );

    const commentAfter = screen.getByLabelText(/comment/i) as HTMLInputElement;
    expect(commentAfter.value).toBe("in progress notes");
  });

  it("resets the form when the target actually changes (different targetKey)", () => {
    const onSave = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ToastProvider>
        <ReviewPanel
          target={baseTarget({ targetKey: "result-1" })}
          open
          onOpenChange={onOpenChange}
          onSave={onSave}
        />
      </ToastProvider>,
    );

    const comment = screen.getByLabelText(/comment/i) as HTMLInputElement;
    fireEvent.change(comment, { target: { value: "notes for result 1" } });

    rerender(
      <ToastProvider>
        <ReviewPanel
          target={baseTarget({ targetKey: "result-2" })}
          open
          onOpenChange={onOpenChange}
          onSave={onSave}
        />
      </ToastProvider>,
    );

    const commentAfter = screen.getByLabelText(/comment/i) as HTMLInputElement;
    expect(commentAfter.value).toBe("");
  });

  it("keeps the drawer open and does not toast success when onSave rejects", async () => {
    const onOpenChange = vi.fn();
    const onSave = vi.fn().mockRejectedValue(new Error("network error"));
    render(
      <ToastProvider>
        <ReviewPanel target={baseTarget()} open onOpenChange={onOpenChange} onSave={onSave} />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save review" }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/could not save/i)).toBeDefined());
    expect(screen.queryByText("Review saved")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("toasts success and closes the drawer when onSave resolves", async () => {
    const onOpenChange = vi.fn();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ToastProvider>
        <ReviewPanel target={baseTarget()} open onOpenChange={onOpenChange} onSave={onSave} />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save review" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.getByText("Review saved")).toBeDefined();
  });
});
