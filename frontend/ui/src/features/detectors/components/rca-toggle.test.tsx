// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RcaToggle } from "./rca-toggle";

afterEach(() => cleanup());

describe("RcaToggle", () => {
  it("disables the switch when the detector form is read-only", () => {
    const onCheckedChange = vi.fn();

    render(
      <RcaToggle id="detector-rca" checked={true} onCheckedChange={onCheckedChange} disabled />,
    );

    const toggle = screen.getByRole("switch");
    expect((toggle as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(toggle);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
