// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, cleanup, screen, fireEvent } from "@testing-library/react";
import { parseMetadataEntries } from "@/features/traces/utils/metadata";
import { TraceMetadataCell } from "./TraceMetadataCell";

afterEach(cleanup);

/**
 * Who owns focus when the metadata reveal opens and closes. The governing rule is that an
 * interaction which did not take focus must not give it away, and one which did take it must
 * give it back — so the same close has to behave two different ways depending on how the open
 * started, and neither answer may be reached by asking "was a pointer involved at all".
 *
 * These render the cell on its own beside a text field rather than through `TraceListTable`,
 * because every assertion here needs somewhere real for focus to have been and to return to;
 * the table's own tests are about which columns it draws and are cell-agnostic.
 */
describe("TraceMetadataCell focus ownership", () => {
  // Radix's popover positioning observes its anchor, and jsdom ships no ResizeObserver.
  beforeAll(() => {
    if (!("ResizeObserver" in globalThis)) {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  // Both closes are deferred — the hover close behind its grace period, and the focus Radix
  // hands back behind a task of its own — so every test here runs the clock out by hand.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const METADATA = { tenant: "acme", region: "eu-west-1" };

  /** The rest of the page, reduced to the one part of it that can hold focus. */
  const FIELD_LABEL = "Filter";

  function renderCell() {
    render(
      <>
        <input aria-label={FIELD_LABEL} defaultValue="" />
        <table>
          <tbody>
            <tr>
              <TraceMetadataCell entries={parseMetadataEntries(METADATA)} />
            </tr>
          </tbody>
        </table>
      </>,
    );
    return {
      trigger: screen.getByRole("button"),
      field: screen.getByRole("textbox", { name: FIELD_LABEL }) as HTMLInputElement,
    };
  }

  const revealSurface = () => screen.getByRole("dialog", { name: "Metadata" });
  const queryRevealSurface = () => screen.queryByRole("dialog", { name: "Metadata" });

  /**
   * Runs the clock out twice over. The grace period ends in a state update, and the focus
   * Radix hands back on close is deferred behind a task that is only scheduled once that
   * update has torn the surface down — so one advance closes the surface and a second one
   * delivers the focus. Advancing once leaves the restoration permanently pending, which
   * would make "focus did not move" true of every one of these tests for the wrong reason.
   */
  function settle() {
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
  }

  /**
   * Types the way a keyboard does — into whatever holds focus, not into a chosen element — so
   * a keystroke the user aimed at the field lands nowhere once focus has moved off it. That
   * is what makes the field's value, rather than `document.activeElement` alone, the proof
   * that a stolen focus is something the user loses work to.
   */
  function typeWhereFocusIs(text: string) {
    for (const character of text) {
      const target = document.activeElement;
      if (!(target instanceof HTMLInputElement)) continue;
      fireEvent.change(target, { target: { value: target.value + character } });
    }
  }

  it("leaves the user's typing where it was when the pointer opens and then leaves the reveal", () => {
    // The pointer took nothing, so it has nothing to give back: pulling focus onto the trigger
    // on the way out drops the keystrokes that were still coming.
    const { trigger, field } = renderCell();
    field.focus();
    typeWhereFocusIs("sess");

    fireEvent.pointerEnter(trigger);

    expect(revealSurface()).toBeTruthy();
    expect(document.activeElement).toBe(field);

    fireEvent.pointerLeave(trigger);
    settle();

    expect(queryRevealSurface()).toBeNull();
    // The field's value is asserted before its focus because the value is the damage: a
    // reveal that takes focus on the way out reads to the user as keystrokes going missing.
    typeWhereFocusIs("ion");
    expect(field.value).toBe("session");
    expect(document.activeElement).toBe(field);
  });

  it("returns focus to the collapsed line when Escape dismisses a keyboard-opened reveal", () => {
    // Enter and Space arrive as a click with no originating pointer, which `detail: 0`
    // reproduces. This open moved focus into the surface, so this close owes it back — and
    // whatever suppresses the restoration in the hover case must not reach this one.
    const { trigger } = renderCell();
    trigger.focus();

    fireEvent.click(trigger, { detail: 0 });

    const surface = revealSurface();
    expect(surface.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(surface, { key: "Escape" });
    settle();

    expect(queryRevealSurface()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the collapsed line when the keyboard takes over a reveal the pointer opened", () => {
    // A pointer opened this one, but the keyboard activation that followed moved focus into
    // the surface, so the close owes it back all the same. Asking only "did a pointer open
    // this?" answers yes here and strands focus on `document.body`.
    const { trigger } = renderCell();
    trigger.focus();
    fireEvent.pointerEnter(trigger);
    const surface = revealSurface();
    expect(surface.contains(document.activeElement)).toBe(false);

    fireEvent.click(trigger, { detail: 0 });

    expect(surface.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(surface, { key: "Escape" });
    settle();

    expect(queryRevealSurface()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the collapsed line when the pointer only brushes a keyboard-opened reveal", () => {
    // The keyboard opened this one and holds its focus. A pointer arriving afterwards is not
    // a second opening, so it cannot hand ownership of the focus to a hover that never had it.
    const { trigger } = renderCell();
    trigger.focus();
    fireEvent.click(trigger, { detail: 0 });
    const surface = revealSurface();
    expect(surface.contains(document.activeElement)).toBe(true);

    fireEvent.pointerEnter(trigger);
    fireEvent.pointerLeave(trigger);
    settle();

    expect(queryRevealSurface()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
