// @vitest-environment jsdom
import type { FormEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

// Radix Select opens on pointerdown and relies on pointer-capture APIs jsdom
// doesn't implement.
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const { useProjectMock, useSlackStatusMock } = vi.hoisted(() => ({
  useProjectMock: vi.fn(),
  useSlackStatusMock: vi.fn(),
}));

vi.mock("@/features/projects/hooks", () => ({ useProject: useProjectMock }));
vi.mock("@/features/integrations/hooks/useSlackIntegration", () => ({
  useSlackStatus: useSlackStatusMock,
}));

import { NotificationsSection } from "./notifications-section";
import {
  ALERT_NAME_MAX,
  ALERT_RENOTIFY_MAX_MINUTES,
  DEFAULT_ALERT_RENOTIFY_INTERVAL_MINUTES,
  type AlertRenotify,
} from "../rule-model";

const baseProps = () => ({
  projectId: "proj-1",
  noDataMode: "HOLD" as const,
  renotify: { mode: "OFF" } as AlertRenotify,
  name: "p95 latency",
  onNoDataModeChange: vi.fn(),
  onRenotifyChange: vi.fn(),
  onNameChange: vi.fn(),
});

describe("NotificationsSection", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const renderSection = () => {
    const props = baseProps();
    render(<NotificationsSection {...props} />);
    return props.onNameChange;
  };

  it("forwards name edits and caps the input at the alert name limit", () => {
    useProjectMock.mockReturnValue({ data: { workspace_id: "ws-1" } });
    useSlackStatusMock.mockReturnValue({ data: { connected: false } });
    const onNameChange = renderSection();
    const input = screen.getByLabelText("name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "error rate" } });
    expect(onNameChange).toHaveBeenCalledWith("error rate");
    expect(input.maxLength).toBe(ALERT_NAME_MAX);
  });

  it("shows the loading fallback until the workspace is known", () => {
    useProjectMock.mockReturnValue({ data: undefined });
    useSlackStatusMock.mockReturnValue({ data: undefined });
    renderSection();
    expect(screen.getByText("Loading workspace...")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(useSlackStatusMock).toHaveBeenCalledWith(undefined);
  });

  it("keeps the loading fallback while the Slack status is still in flight", () => {
    useProjectMock.mockReturnValue({ data: { workspace_id: "ws-1" } });
    useSlackStatusMock.mockReturnValue({ data: undefined, isLoading: true });
    renderSection();
    expect(screen.getByText("Loading workspace...")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("Connect Slack")).toBeNull();
  });

  it("reports a workspace that failed to load instead of loading forever", () => {
    useProjectMock.mockReturnValue({ data: undefined, isError: true });
    useSlackStatusMock.mockReturnValue({ data: undefined });
    renderSection();
    expect(
      screen.getByText("The workspace could not be loaded. Reload the page to try again."),
    ).toBeTruthy();
    expect(screen.queryByText("Loading workspace...")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("nudges toward channel selection when Slack has none", () => {
    useProjectMock.mockReturnValue({ data: { workspace_id: "ws-1" } });
    useSlackStatusMock.mockReturnValue({ data: { connected: true, teamName: "Acme" } });
    renderSection();
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/workspaces/ws-1/settings/integrations");
    expect(
      screen.getByText("Alerts need a channel. Select one in workspace settings."),
    ).toBeTruthy();
  });
});

describe("NotificationsSection no-data mode and renotify", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const renderSection = (overrides: Partial<Parameters<typeof NotificationsSection>[0]> = {}) => {
    useProjectMock.mockReturnValue({ data: { workspace_id: "ws-1" } });
    useSlackStatusMock.mockReturnValue({ data: { connected: false } });
    const props = { ...baseProps(), ...overrides };
    render(<NotificationsSection {...props} />);
    return props;
  };

  const openSelect = (label: string) =>
    fireEvent.pointerDown(screen.getByLabelText(label), { button: 0, pointerType: "mouse" });

  it("shows the rule's no-data mode and emits the chosen one", () => {
    const props = renderSection({ noDataMode: "ZERO" });
    expect(screen.getByLabelText("no data mode").textContent).toContain("Treat as zero");
    // The hint tracks the selection, so the consequence of the chosen mode is on
    // screen rather than a label the reader has to interpret.
    expect(screen.getByText(/empty window counts as 0/i)).toBeTruthy();
    openSelect("no data mode");
    fireEvent.click(screen.getByRole("option", { name: "Notify when data stops" }));
    expect(props.onNoDataModeChange).toHaveBeenCalledWith("NOTIFY");
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

  it("blocks a submit while the interval sits blank instead of sending the stale value", () => {
    useProjectMock.mockReturnValue({ data: { workspace_id: "ws-1" } });
    useSlackStatusMock.mockReturnValue({ data: { connected: false } });
    const onSubmit = vi.fn((e: FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <NotificationsSection {...baseProps()} renotify={{ mode: "EVERY", intervalMinutes: 45 }} />
      </form>,
    );
    const input = screen.getByLabelText("renotify interval") as HTMLInputElement;
    input.form!.requestSubmit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: "" } });
    expect(input.validity.valueMissing).toBe(true);
    input.form!.requestSubmit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
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
