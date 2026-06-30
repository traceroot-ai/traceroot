// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { DeleteDetectorDialog } from "./delete-detector-dialog";

afterEach(() => {
  cleanup();
});

describe("DeleteDetectorDialog", () => {
  it("renders mutation errors in the confirmation dialog", () => {
    render(
      <DeleteDetectorDialog
        detectorName="Latency spikes"
        isOpen
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        errorMessage="Admins can delete detectors for this project."
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Admins can delete detectors for this project.",
    );
  });
});
