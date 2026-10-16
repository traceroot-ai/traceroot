// @vitest-environment jsdom
import { StrictMode, useRef, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useScrollToTopOnChange } from "./use-scroll-to-top-on-change";

// jsdom does no layout, so scrollTop is a plain property here: whatever is written
// is what reads back. `restoredScroll` puts the list at an offset as it attaches,
// before any effect runs, as a restored scroll position would.
function List({
  listKey,
  label = "",
  restoredScroll,
}: {
  listKey: string;
  label?: string;
  restoredScroll?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useScrollToTopOnChange(ref, listKey);
  const attach = (el: HTMLDivElement | null) => {
    if (el && restoredScroll && ref.current !== el) el.scrollTop = restoredScroll;
    ref.current = el;
  };
  return (
    <div ref={attach} data-testid="list">
      {label}
    </div>
  );
}

const strict = (node: ReactNode) => <StrictMode>{node}</StrictMode>;

const list = () => screen.getByTestId("list");

// As if the user had scrolled down the current page.
const scrollDown = () => {
  list().scrollTop = 400;
};

afterEach(cleanup);

describe("useScrollToTopOnChange", () => {
  it("leaves the scroll position alone on mount", () => {
    render(<List listKey="0:50" restoredScroll={400} />);

    expect(list().scrollTop).toBe(400);
  });

  it("leaves the scroll position alone on mount under StrictMode", () => {
    // StrictMode runs mount effects twice; the second run must not read as a change.
    render(strict(<List listKey="0:50" restoredScroll={400} />));

    expect(list().scrollTop).toBe(400);
  });

  it("scrolls back to the top when the key changes", () => {
    const { rerender } = render(<List listKey="0:50" />);
    scrollDown();

    rerender(<List listKey="1:50" />);

    expect(list().scrollTop).toBe(0);
  });

  it("scrolls back to the top when the key changes under StrictMode", () => {
    const { rerender } = render(strict(<List listKey="0:50" />));
    scrollDown();

    rerender(strict(<List listKey="1:50" />));

    expect(list().scrollTop).toBe(0);
  });

  it("keeps the scroll position on a re-render that keeps the key", () => {
    const { rerender } = render(<List listKey="1:50" />);
    rerender(<List listKey="2:50" />);
    scrollDown();

    rerender(<List listKey="2:50" label="refetched rows" />);

    expect(list().scrollTop).toBe(400);
  });
});
