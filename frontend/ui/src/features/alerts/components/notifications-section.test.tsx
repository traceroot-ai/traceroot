// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const { useProjectMock, useSlackStatusMock } = vi.hoisted(() => ({
  useProjectMock: vi.fn(),
  useSlackStatusMock: vi.fn(),
}));

vi.mock("@/features/projects/hooks", () => ({ useProject: useProjectMock }));
vi.mock("@/features/integrations/hooks/useSlackIntegration", () => ({
  useSlackStatus: useSlackStatusMock,
}));

import { NotificationsSection } from "./notifications-section";
import { ALERT_NAME_MAX } from "../rule-model";

describe("NotificationsSection", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const renderSection = () => {
    const onNameChange = vi.fn();
    render(
      <NotificationsSection projectId="proj-1" name="p95 latency" onNameChange={onNameChange} />,
    );
    return onNameChange;
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
