// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SignalsEmptyState } from "./signals-empty-state";

afterEach(cleanup);

const setup = (over: Record<string, number> = {}) => ({
  signalCount: 0,
  detectorCount: 1,
  signalDetectorCount: 1,
  sampledSignalDetectorCount: 1,
  ...over,
});

const shown = (s: ReturnType<typeof setup>) => {
  render(<SignalsEmptyState projectId="p1" setup={s} />);
  const link = screen.getByRole("link");
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

  it("asks to raise sampling when every grouping detector samples 0%", () => {
    expect(shown(setup({ sampledSignalDetectorCount: 0 }))).toEqual({
      title: "Finish detector setup",
      link: ["Configure detectors", "/projects/p1/detectors"],
    });
  });

  it("waits for the first signal once setup is complete", () => {
    expect(shown(setup())).toEqual({
      title: "No signals yet",
      link: ["View detectors", "/projects/p1/detectors"],
    });
    expect(screen.getByText(/Signals appear here when a detector groups/)).toBeTruthy();
  });
});
