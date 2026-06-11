// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { getTemplate } from "../templates";

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
}));

vi.mock("../hooks/use-detectors", () => ({
  useCreateDetector: () => ({ mutateAsync: mocks.mutateAsync }),
}));

import { AddDetectorsStep } from "./add-detectors-step";

function renderStep() {
  const onDone = vi.fn();
  render(<AddDetectorsStep projectId="proj-1" projectName="checkout-agent" onDone={onDone} />);
  return { onDone };
}

const pill = (label: string) => screen.getByRole("button", { name: label });
const continueButton = () => screen.getByRole("button", { name: "Continue" });

afterEach(() => {
  cleanup();
  mocks.mutateAsync.mockReset();
});

describe("AddDetectorsStep", () => {
  it("renders the five quick-add templates and no Blank pill", () => {
    renderStep();
    for (const label of ["Failure", "Hallucination", "Logic Error", "Task Completion", "Safety"]) {
      expect(pill(label)).toBeDefined();
    }
    expect(screen.queryByRole("button", { name: "Blank" })).toBeNull();
    expect(screen.getByText("checkout-agent")).toBeDefined();
  });

  it("shows the description of the hovered template", () => {
    renderStep();
    fireEvent.mouseEnter(pill("Safety"));
    expect(screen.getByText(getTemplate("safety")!.description)).toBeDefined();
    fireEvent.mouseEnter(pill("Failure"));
    expect(screen.getByText(getTemplate("failure")!.description)).toBeDefined();
    // clicking selects but does not move the description
    fireEvent.click(pill("Safety"));
    expect(screen.getByText(getTemplate("failure")!.description)).toBeDefined();
  });

  it("calls onDone without posting when continuing with nothing selected", () => {
    const { onDone } = renderStep();
    fireEvent.click(continueButton());
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("calls onDone on skip", () => {
    const { onDone } = renderStep();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("creates one detector per selected template with the shared defaults", async () => {
    mocks.mutateAsync.mockResolvedValue({ id: "det-1" });
    const { onDone } = renderStep();
    fireEvent.click(pill("Failure"));
    fireEvent.click(pill("Safety"));
    fireEvent.click(continueButton());

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(2);
    const payloads = mocks.mutateAsync.mock.calls.map((c) => c[0]);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        template: "failure",
        name: "Failure Detector",
        sampleRate: 100,
        enableRca: true,
        detectionSource: "system",
      }),
    );
    expect(payloads).toContainEqual(expect.objectContaining({ template: "safety" }));
  });

  it("deselecting a pill removes it from the submission", async () => {
    mocks.mutateAsync.mockResolvedValue({ id: "det-1" });
    const { onDone } = renderStep();
    fireEvent.click(pill("Failure"));
    fireEvent.click(pill("Safety"));
    fireEvent.click(pill("Failure")); // toggle back off
    fireEvent.click(continueButton());

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.mutateAsync.mock.calls[0][0]).toMatchObject({ template: "safety" });
  });

  it("keeps failed templates selected with an inline error, and retries only those", async () => {
    mocks.mutateAsync.mockImplementation((input: { template: string }) =>
      input.template === "safety"
        ? Promise.reject(new Error("Failed to create detector: 500"))
        : Promise.resolve({ id: "det-1" }),
    );
    const { onDone } = renderStep();
    fireEvent.click(pill("Failure"));
    fireEvent.click(pill("Safety"));
    fireEvent.click(continueButton());

    await waitFor(() => expect(screen.getByText(/Couldn't create: Safety/)).toBeDefined());
    expect(onDone).not.toHaveBeenCalled();

    // Retry: only the failed template is re-posted
    mocks.mutateAsync.mockClear();
    mocks.mutateAsync.mockResolvedValue({ id: "det-2" });
    fireEvent.click(continueButton());

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.mutateAsync.mock.calls[0][0]).toMatchObject({ template: "safety" });
  });
});
