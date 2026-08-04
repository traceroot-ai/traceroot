// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ComparabilityBanner } from "./comparability-banner";

afterEach(() => cleanup());

describe("ComparabilityBanner", () => {
  it("renders nothing for a trustworthy comparison (the view shows its own verdict)", () => {
    const { container } = render(<ComparabilityBanner state="trustworthy" reasons={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("is a strong alert for an exploratory (cross-evaluation) comparison, with the concrete reason", () => {
    render(<ComparabilityBanner state="exploratory" reasons={["different_evaluation"]} />);
    // role=alert → assistive tech announces it; the deltas are explicitly NOT a verdict.
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/not directly comparable/i)).toBeDefined();
    expect(screen.getByText(/ship \/ no-ship/i)).toBeDefined();
    expect(screen.getByText(/different evaluations/i)).toBeDefined();
  });

  it("lists every concrete reason for an exploratory comparison", () => {
    render(
      <ComparabilityBanner
        state="exploratory"
        reasons={["different_dataset_version", "main_scorer_incompatible"]}
      />,
    );
    expect(screen.getByText(/different dataset snapshots/i)).toBeDefined();
    expect(screen.getByText(/main scorer isn’t comparable/i)).toBeDefined();
  });

  it("is informational (not an alert) while a run is still pending", () => {
    render(<ComparabilityBanner state="pending" reasons={["candidate_not_terminal"]} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/comparison pending/i)).toBeDefined();
    expect(screen.getByText(/still going/i)).toBeDefined();
  });

  it("is muted with a way out when there is no baseline", () => {
    render(
      <ComparabilityBanner
        state="unavailable"
        reasons={["no_baseline"]}
        action={<button>Clear</button>}
      />,
    );
    expect(screen.getByText(/no comparison/i)).toBeDefined();
    expect(screen.getByText(/no baseline was picked/i)).toBeDefined();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDefined();
  });
});
