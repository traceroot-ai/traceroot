// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

// Radix Select opens on pointerdown and relies on pointer-capture APIs jsdom
// doesn't implement.
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.scrollIntoView = vi.fn();

import { ConditionSection } from "./condition-section";
import {
  ALERT_RENOTIFY_MAX_MINUTES,
  DEFAULT_ALERT_RENOTIFY_INTERVAL_MINUTES,
  type AlertRenotify,
} from "../rule-model";

describe("ConditionSection", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const renderSection = (overrides: Partial<Parameters<typeof ConditionSection>[0]> = {}) => {
    const props = {
      operator: ">" as const,
      threshold: "5",
      window: "10m" as const,
      renotify: { mode: "OFF" } as AlertRenotify,
      onOperatorChange: vi.fn(),
      onThresholdChange: vi.fn(),
      onWindowChange: vi.fn(),
      onRenotifyChange: vi.fn(),
      ...overrides,
    };
    render(<ConditionSection {...props} />);
    return props;
  };

  const openSelect = (label: string) =>
    fireEvent.pointerDown(screen.getByLabelText(label), { button: 0, pointerType: "mouse" });

  it("emits the chosen operator", () => {
    const props = renderSection();
    openSelect("operator");
    fireEvent.click(screen.getByRole("option", { name: "≥" }));
    expect(props.onOperatorChange).toHaveBeenCalledWith(">=");
  });

  it("passes threshold keystrokes through unparsed", () => {
    const props = renderSection();
    fireEvent.change(screen.getByLabelText("threshold"), { target: { value: "12.5" } });
    expect(props.onThresholdChange).toHaveBeenCalledWith("12.5");
  });

  it("labels windows as lookbacks and emits the bare token", () => {
    const props = renderSection();
    openSelect("window");
    expect(screen.getByRole("option", { name: "Last 10m" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Last 30m" }));
    expect(props.onWindowChange).toHaveBeenCalledWith("30m");
  });

  it("switching renotify on emits EVERY with the default interval", () => {
    const props = renderSection();
    expect(screen.queryByLabelText("renotify interval")).toBeNull();
    openSelect("renotify");
    fireEvent.click(screen.getByRole("option", { name: "Re-alert at a regular interval" }));
    expect(props.onRenotifyChange).toHaveBeenCalledWith({
      mode: "EVERY",
      intervalMinutes: DEFAULT_ALERT_RENOTIFY_INTERVAL_MINUTES,
    });
  });

  it("switching renotify off drops the interval entirely", () => {
    const props = renderSection({ renotify: { mode: "EVERY", intervalMinutes: 15 } });
    openSelect("renotify");
    fireEvent.click(screen.getByRole("option", { name: "Off (alert only on transitions)" }));
    expect(props.onRenotifyChange).toHaveBeenCalledWith({ mode: "OFF" });
  });

  it("commits an in-range interval on each keystroke", () => {
    const props = renderSection({ renotify: { mode: "EVERY", intervalMinutes: 60 } });
    fireEvent.change(screen.getByLabelText("renotify interval"), { target: { value: "30" } });
    expect(props.onRenotifyChange).toHaveBeenCalledWith({ mode: "EVERY", intervalMinutes: 30 });
  });

  it("holds an out-of-range interval until blur, then clamps it", () => {
    const props = renderSection({ renotify: { mode: "EVERY", intervalMinutes: 60 } });
    const input = screen.getByLabelText("renotify interval") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "999999" } });
    expect(props.onRenotifyChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(props.onRenotifyChange).toHaveBeenCalledWith({
      mode: "EVERY",
      intervalMinutes: ALERT_RENOTIFY_MAX_MINUTES,
    });
    expect(input.value).toBe(String(ALERT_RENOTIFY_MAX_MINUTES));
  });

  it("restores the last committed interval when blurred blank", () => {
    const props = renderSection({ renotify: { mode: "EVERY", intervalMinutes: 45 } });
    const input = screen.getByLabelText("renotify interval") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(props.onRenotifyChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(props.onRenotifyChange).toHaveBeenCalledWith({ mode: "EVERY", intervalMinutes: 45 });
    expect(input.value).toBe("45");
  });
});
