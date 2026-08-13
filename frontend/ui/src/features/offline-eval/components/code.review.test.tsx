// @vitest-environment jsdom
/**
 * EditableValueBlock's `seedJson` re-seed effect. It must normalise a freshly
 * seeded value exactly once (per `collapseResetKey`) and then leave the field
 * alone — the effect keeps `text` in its dependency array so it can seed once
 * real content arrives, but re-running it on every keystroke would fight the
 * user's own typing (any in-progress edit that happens to parse as JSON gets
 * pretty-printed out from under the cursor).
 */
import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import * as React from "react";
import { EditableValueBlock } from "./code";

afterEach(cleanup);

/** Mirrors how a real caller (e.g. the Save-as-test-case drawer) wires this up:
 *  the block's own value lives in the parent, `onChange` writes it back, and a
 *  new seed is applied to that same state in lockstep with `collapseResetKey`
 *  (the drawer's `seedGeneration` bumps together with `setInput`/`setOutput`/
 *  `setMetadata`, in the very same effect, so the two always change in one
 *  commit — never `collapseResetKey` alone, one render ahead of the text). */
function Harness({ seedText, collapseResetKey }: { seedText: string; collapseResetKey?: string }) {
  const [text, setText] = React.useState(seedText);
  const prevKeyRef = React.useRef(collapseResetKey);
  if (prevKeyRef.current !== collapseResetKey) {
    prevKeyRef.current = collapseResetKey;
    if (text !== seedText) setText(seedText);
  }
  return (
    <EditableValueBlock
      label="Output"
      text={text}
      onChange={setText}
      seedJson="expanded"
      collapseResetKey={collapseResetKey}
    />
  );
}

describe("EditableValueBlock — seedJson re-seeding", () => {
  it("pretty-prints the initial (compact JSON) seed", () => {
    render(<Harness seedText='{"a":1}' />);
    const textarea = screen.getByLabelText("Output") as HTMLTextAreaElement;
    expect(textarea.value).toBe('{\n  "a": 1\n}');
  });

  it("does not rewrite a further edit that also happens to parse as JSON", () => {
    render(<Harness seedText='{"a":1}' />);
    const textarea = screen.getByLabelText("Output") as HTMLTextAreaElement;
    // The initial seed already landed (asserted above); now the user replaces the
    // whole value with a different, still-valid, compact JSON value.
    fireEvent.change(textarea, { target: { value: "[1,2]\n" } });
    // A re-seed would pretty-print this to "[\n  1,\n  2\n]" and move the caret —
    // it must instead stay exactly what was typed.
    expect(textarea.value).toBe("[1,2]\n");
  });

  it("re-seeds once more when collapseResetKey changes (a genuinely new source)", () => {
    const { rerender } = render(<Harness seedText='{"a":1}' collapseResetKey="span-1" />);
    let textarea = screen.getByLabelText("Output") as HTMLTextAreaElement;
    expect(textarea.value).toBe('{\n  "a": 1\n}');

    rerender(<Harness seedText='{"b":2}' collapseResetKey="span-2" />);
    textarea = screen.getByLabelText("Output") as HTMLTextAreaElement;
    expect(textarea.value).toBe('{\n  "b": 2\n}');
  });
});
