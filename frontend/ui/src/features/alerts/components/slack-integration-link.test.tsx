// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

import { SlackIntegrationLink } from "./slack-integration-link";

describe("SlackIntegrationLink", () => {
  afterEach(cleanup);

  it("invites connection when disconnected", () => {
    render(
      <SlackIntegrationLink href="/workspaces/ws-1/settings/integrations" isConnected={false} />,
    );
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/workspaces/ws-1/settings/integrations");
    expect(screen.getByText("Connect Slack")).toBeTruthy();
    expect(screen.queryByText("Manage")).toBeNull();
  });

  it("names the team and channel when both are set", () => {
    render(
      <SlackIntegrationLink
        href="/integrations"
        isConnected
        teamName="Acme"
        channelName="alerts"
      />,
    );
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("· #alerts")).toBeTruthy();
    expect(screen.getByText("Manage")).toBeTruthy();
    expect(screen.queryByText("Connect Slack")).toBeNull();
  });

  it("flags the missing channel when connected without one", () => {
    render(<SlackIntegrationLink href="/integrations" isConnected teamName="Acme" />);
    expect(screen.getByText("· No channel selected")).toBeTruthy();
    expect(screen.getByText("Manage")).toBeTruthy();
  });
});
