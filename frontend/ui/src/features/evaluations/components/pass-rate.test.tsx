// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PassRate } from "./pass-rate";

const counts = (p: number, f: number, e = 0, n = 0) => ({
  passedCount: p,
  failedCount: f,
  erroredCount: e,
  notScoredCount: n,
});

afterEach(() => cleanup());

describe("PassRate", () => {
  it("renders the fraction and the percentage", () => {
    render(<PassRate counts={counts(18, 4)} />);
    expect(screen.getByText("18/22")).toBeDefined();
    expect(screen.getByText("81.8%")).toBeDefined();
  });

  // The load-bearing rule from the spec.
  it("renders an em dash, never 0%, when nothing was judged", () => {
    render(<PassRate counts={counts(0, 0, 25, 0)} />);
    expect(screen.getByText("—")).toBeDefined();
    expect(screen.queryByText("0.0%")).toBeNull();
  });

  it("renders 0.0% when cases were judged and all failed", () => {
    render(<PassRate counts={counts(0, 5)} />);
    expect(screen.getByText("0.0%")).toBeDefined();
  });

  it("exposes excluded cases via the title attribute", () => {
    const { container } = render(<PassRate counts={counts(18, 4, 2, 1)} />);
    expect(container.querySelector("[title]")?.getAttribute("title")).toBe(
      "2 errored, 1 not scored",
    );
  });

  it("adds the word 'passed' in label form", () => {
    render(<PassRate counts={counts(18, 4)} withLabel />);
    expect(screen.getByText(/18\/22 passed/)).toBeDefined();
  });
});
