// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const layout = vi.hoisted(() => ({ loopsEnabled: true }));
vi.mock("@/components/layout/app-layout", () => ({ useLayout: () => layout }));

import { SignalsEmptyState } from "./signals-empty-state";

beforeEach(() => {
  layout.loopsEnabled = true;
});
afterEach(cleanup);

const setup = (over: Record<string, number | boolean> = {}) => ({
  signalCount: 0,
  detectorCount: 1,
  signalDetectorCount: 1,
  sampledSignalDetectorCount: 1,
  grouping: true,
  ...over,
});

const shown = (s: ReturnType<typeof setup>) => {
  render(<SignalsEmptyState projectId="p1" setup={s} />);
  const link = screen.getByRole("link", { name: /detector/ });
  return {
    title: screen.getByRole("heading").textContent,
    link: [link.textContent, link.getAttribute("href")],
  };
};

describe("SignalsEmptyState", () => {
  it("asks for a detector when the project has none", () => {
    expect(shown(setup({ detectorCount: 0, signalDetectorCount: 0 }))).toEqual({
      title: "No signals yet",
      link: ["Create detector", "/projects/p1/detectors/new"],
    });
    expect(screen.getByText(/turn on Generate signals in its Signals section/)).toBeTruthy();
  });

  it("asks to turn on Generate signals when no detector groups its hits", () => {
    expect(shown(setup({ signalDetectorCount: 0, sampledSignalDetectorCount: 0 }))).toEqual({
      title: "Enable signal generation",
      link: ["Configure detectors", "/projects/p1/detectors"],
    });
  });

  it("asks to turn a grouping detector on and raise its sampling when none evaluates traces", () => {
    expect(shown(setup({ sampledSignalDetectorCount: 0 }))).toEqual({
      title: "Finish detector setup",
      link: ["Configure detectors", "/projects/p1/detectors"],
    });
    expect(
      screen.getByText(/Make sure the detector is on and its sampling is above 0%/),
    ).toBeTruthy();
  });

  it("says when the deployment cannot group hits", () => {
    shown(setup({ grouping: false }));
    expect(screen.getByText(/this deployment has no OpenAI API key/)).toBeTruthy();
  });

  it("waits for the first signal once setup is complete", () => {
    expect(shown(setup())).toEqual({
      title: "No signals yet",
      link: ["View detectors", "/projects/p1/detectors"],
    });
    expect(screen.getByText(/Signals appear here when a detector groups/)).toBeTruthy();
  });

  it("offers a Loop as the other way to get signals", () => {
    for (const s of [setup({ detectorCount: 0, signalDetectorCount: 0 }), setup()]) {
      const { unmount } = render(<SignalsEmptyState projectId="p1" setup={s} />);
      const link = screen.getByRole("link", { name: "Or start a loop" });
      expect(link.getAttribute("href")).toBe("/projects/p1/loops");
      unmount();
    }
  });

  it("offers no loop where loops are switched off", () => {
    layout.loopsEnabled = false;
    render(<SignalsEmptyState projectId="p1" setup={setup()} />);
    expect(screen.queryByRole("link", { name: "Or start a loop" })).toBeNull();
    expect(screen.getByRole("link", { name: /detector/ })).toBeTruthy();
  });
});
