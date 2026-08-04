// @vitest-environment jsdom
/**
 * Coverage for the human review drawer — the one thing a person authors in the
 * offline-eval UI. Exercises seeding from an existing review, the verdict /
 * quality / comment controls, the optional evidence toggle and saving.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/toast";
import { ReviewPanel, type ReviewTarget } from "./review-panel";

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

afterEach(() => cleanup());

const TARGET: ReviewTarget = {
  targetKey: "run-27:case-1",
  contextLabel: "Run 27 · case-1",
  input: "I was charged twice for my July invoice",
  output: "billing",
  expected: "billing",
  autoScores: [
    { name: "routing-accuracy", display: "Pass", explanation: "Reached billing" },
    { name: "tone", display: "0.8" },
  ],
};

type PanelProps = Omit<
  Partial<React.ComponentProps<typeof ReviewPanel>>,
  "onSave" | "onOpenChange"
>;

function renderPanel(props: PanelProps = {}) {
  const onSave = vi.fn();
  const onOpenChange = vi.fn();
  const result = render(
    <ToastProvider>
      <ReviewPanel target={TARGET} open onOpenChange={onOpenChange} onSave={onSave} {...props} />
    </ToastProvider>,
  );
  return { ...result, onSave, onOpenChange };
}

describe("ReviewPanel", () => {
  it("renders nothing without a target", () => {
    const { container } = render(
      <ToastProvider>
        <ReviewPanel target={null} open onOpenChange={vi.fn()} onSave={vi.fn()} />
      </ToastProvider>,
    );
    expect(container.textContent).toBe("");
  });

  it("renders the target context, values and automatic scores", () => {
    renderPanel();
    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getByText("Run 27 · case-1")).toBeTruthy();
    expect(screen.getByText("I was charged twice for my July invoice")).toBeTruthy();
    expect(screen.getByText("routing-accuracy:")).toBeTruthy();
    expect(screen.getByText("Reached billing")).toBeTruthy();
    // A score with no explanation renders just its display value.
    expect(screen.getByText("0.8")).toBeTruthy();
  });

  it("explains an absent expected output instead of leaving it blank", () => {
    renderPanel({ target: { ...TARGET, expected: null } });
    expect(screen.getByText(/Not required — a scorer judges the output directly/)).toBeTruthy();
  });

  it("omits the automatic-scores block when there are none", () => {
    renderPanel({ target: { ...TARGET, autoScores: [] } });
    expect(screen.queryByText("Automatic scores")).toBeNull();
  });

  it("defaults to Pass with no quality and an empty comment", () => {
    renderPanel();
    expect(screen.getByRole("radio", { name: "Pass" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "3" }).getAttribute("aria-checked")).toBe("false");
    expect((screen.getByLabelText(/Comment/) as HTMLInputElement).value).toBe("");
  });

  it("seeds from an existing review", () => {
    renderPanel({
      target: {
        ...TARGET,
        existing: {
          verdict: "fail",
          quality: 2,
          comment: "wrong queue",
          reviewer: "Ada",
          at: "2026-07-17T10:30:00Z",
        },
      },
    });
    expect(screen.getByRole("radio", { name: "Fail" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "2" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText(/Comment/) as HTMLInputElement).value).toBe("wrong queue");
  });

  it("changes the verdict", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("radio", { name: "Unsure" }));
    expect(screen.getByRole("radio", { name: "Unsure" }).getAttribute("aria-checked")).toBe("true");
  });

  it("toggles a quality score off when it is picked twice", () => {
    renderPanel();
    const four = screen.getByRole("radio", { name: "4" });
    fireEvent.click(four);
    expect(four.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(four);
    expect(four.getAttribute("aria-checked")).toBe("false");
  });

  it("shows and hides the optional trace evidence", () => {
    renderPanel({ target: { ...TARGET, evidence: <div>trace evidence</div> } });
    expect(screen.queryByText("trace evidence")).toBeNull();
    fireEvent.click(screen.getByText("Show the trace"));
    expect(screen.getByText("trace evidence")).toBeTruthy();
    fireEvent.click(screen.getByText("Hide the trace"));
    expect(screen.queryByText("trace evidence")).toBeNull();
  });

  it("saves the review and closes", async () => {
    const { onSave, onOpenChange } = renderPanel({ savedDescription: "Recorded on run 27." });
    fireEvent.click(screen.getByRole("radio", { name: "Fail" }));
    fireEvent.click(screen.getByRole("radio", { name: "5" }));
    fireEvent.change(screen.getByLabelText(/Comment/), { target: { value: "  wrong  " } });
    fireEvent.click(screen.getByText("Save review"));

    expect(onSave).toHaveBeenCalledTimes(1);
    const review = onSave.mock.calls[0][0];
    expect(review.verdict).toBe("fail");
    expect(review.quality).toBe(5);
    expect(review.comment).toBe("wrong");
    expect(review.reviewer).toBe("You");
    expect(typeof review.at).toBe("string");
    // The drawer only closes once the save has actually persisted — a failure
    // keeps it open with the reviewer's input intact.
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.getByText("Review saved")).toBeTruthy();
  });

  it("drops a whitespace-only comment", () => {
    const { onSave } = renderPanel();
    fireEvent.change(screen.getByLabelText(/Comment/), { target: { value: "   " } });
    fireEvent.click(screen.getByText("Save review"));
    expect(onSave.mock.calls[0][0].comment).toBeUndefined();
  });

  it("closes without saving from Cancel", () => {
    const { onSave, onOpenChange } = renderPanel();
    fireEvent.click(screen.getByText("Cancel"));
    expect(onSave).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders the default footer note and an override", () => {
    const { unmount } = renderPanel();
    expect(screen.getByText("Recorded on this run.")).toBeTruthy();
    unmount();
    renderPanel({ footerNote: "Saved in this page only." });
    expect(screen.getByText("Saved in this page only.")).toBeTruthy();
  });
});
