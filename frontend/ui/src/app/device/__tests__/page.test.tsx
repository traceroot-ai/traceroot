// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../device-client", () => ({
  DeviceClient: () => <div data-testid="device-client" />,
}));

import DevicePage from "../page";

describe("DevicePage", () => {
  it("renders the device client", () => {
    render(<DevicePage />);
    expect(screen.getByTestId("device-client")).toBeDefined();
  });
});
