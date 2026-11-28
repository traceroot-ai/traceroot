// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const slack = vi.hoisted(() => ({
  status: { connected: false } as {
    connected: boolean;
    teamName?: string;
    channel?: { id: string; name: string } | null;
  },
  channels: {
    data: undefined as
      | {
          channels: { id: string; name: string; isPrivate: boolean }[];
          hasPrivateChannelAccess: boolean;
        }
      | undefined,
    isLoading: false,
    error: null as Error | null,
  },
  save: vi.fn(),
  saveState: "idle" as "idle" | "pending" | "success",
  saveError: null as Error | null,
}));
vi.mock("@/features/integrations/hooks/useSlackIntegration", () => ({
  useSlackStatus: () => ({ data: slack.status, isLoading: false }),
  useSlackChannels: () => slack.channels,
  useSaveSlackChannel: () => ({
    mutate: slack.save,
    isIdle: slack.saveState === "idle",
    isPending: slack.saveState === "pending",
    error: slack.saveError,
  }),
}));
const github = vi.hoisted(() => ({
  status: {
    connected: false,
    installations: [] as { installationId: string; accountLogin: string }[],
  } as {
    connected: boolean;
    installations: { installationId: string; accountLogin: string }[];
    available?: boolean;
  },
}));
vi.mock("@/lib/github", () => ({ fetchGitHubConnection: async () => github.status }));
const workspace = vi.hoisted(() => ({ role: "ADMIN" }));
vi.mock("@/features/workspaces/hooks", () => ({ useWorkspace: () => ({ data: workspace }) }));

import { ConnectStep, slackFailureMessage } from "./connect-step";

const RETURN_TO = "/onboarding/connect?projectId=proj_1";
const onContinue = vi.fn();
const onSkip = vi.fn();

function renderStep(
  slackOutcome: { result: string | null; reason: string | null } = { result: null, reason: null },
  githubOutcome: string | null = null,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConnectStep
        workspaceId="ws_1"
        returnTo={RETURN_TO}
        slackOutcome={slackOutcome}
        githubOutcome={githubOutcome}
        onContinue={onContinue}
        onSkip={onSkip}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  slack.status = { connected: false };
  slack.channels = { data: undefined, isLoading: false, error: null };
  slack.save.mockReset();
  slack.saveState = "idle";
  slack.saveError = null;
  github.status = { connected: false, installations: [] };
  workspace.role = "ADMIN";
  onContinue.mockReset();
  onSkip.mockReset();
});
afterEach(cleanup);

const rowOf = (name: string) =>
  screen.getByText(name, { selector: "p" }).closest("div.flex") as HTMLElement;
const hrefOf = (name: string) =>
  new URL(screen.getByRole("link", { name }).getAttribute("href")!, "http://x");

describe("before connecting", () => {
  it("offers both, each coming back to this step with its project", () => {
    renderStep();

    expect(screen.getByText("Link findings to your code")).toBeDefined();
    expect(screen.getByText("Send project alerts to a Slack channel")).toBeDefined();
    const githubHref = hrefOf("Connect GitHub");
    expect(githubHref.pathname).toBe("/api/github/login");
    expect(githubHref.searchParams.get("workspaceId")).toBe("ws_1");
    expect(githubHref.searchParams.get("returnTo")).toBe(RETURN_TO);
    const slackHref = hrefOf("Connect Slack");
    expect(slackHref.pathname).toBe("/api/workspaces/ws_1/slack/install");
    expect(slackHref.searchParams.get("returnTo")).toBe(RETURN_TO);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("goes on to setup from Continue and from Skip for now", () => {
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onContinue).toHaveBeenCalledOnce();
    expect(onSkip).toHaveBeenCalledOnce();
  });
});

describe("someone who is not a workspace admin", () => {
  it("is told admins connect these, and can still go on", () => {
    workspace.role = "MEMBER";
    renderStep();
    expect(screen.getAllByText("Workspace admins can connect this")).toHaveLength(2);
    expect(screen.queryByRole("link", { name: /^Connect/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });
});

describe("GitHub, not set up on this deployment", () => {
  it("says it is unavailable when the deployment reports it, and offers no Connect", async () => {
    github.status = { connected: false, installations: [], available: false };
    renderStep();

    await screen.findByText("Not available on this deployment yet. Continue without it.");
    expect(within(rowOf("GitHub")).getByText("Unavailable")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Connect GitHub" })).toBeNull();
    // Slack is unaffected, and the person can go on either way.
    expect(screen.getByRole("link", { name: "Connect Slack" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onContinue).toHaveBeenCalledOnce();
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("says so when a connection came back with github=unavailable", async () => {
    renderStep({ result: null, reason: null }, "unavailable");
    expect(
      await screen.findByText("Not available on this deployment yet. Continue without it."),
    ).toBeDefined();
    expect(screen.queryByRole("link", { name: "Connect GitHub" })).toBeNull();
  });

  it("offers Connect when the deployment has it set up", async () => {
    github.status = { connected: false, installations: [], available: true };
    renderStep();
    await waitFor(() => expect(screen.getByRole("link", { name: "Connect GitHub" })).toBeDefined());
    expect(screen.getByText("Link findings to your code")).toBeDefined();
  });

  it("still shows an existing connection as connected", async () => {
    github.status = {
      connected: true,
      installations: [{ installationId: "1", accountLogin: "acme" }],
      available: false,
    };
    renderStep();
    await screen.findByText("Connected to acme");
    expect(screen.queryByText("Unavailable")).toBeNull();
  });
});

describe("GitHub, connected", () => {
  it("says so, and to which account", async () => {
    github.status = {
      connected: true,
      installations: [{ installationId: "1", accountLogin: "acme" }],
    };
    renderStep();
    await screen.findByText("Connected to acme");
    expect(screen.queryByRole("link", { name: "Connect GitHub" })).toBeNull();
  });
});

describe("choosing a Slack channel", () => {
  beforeEach(() => {
    slack.status = { connected: true, teamName: "Acme", channel: null };
    slack.channels = {
      data: {
        channels: [
          { id: "C3", name: "incidents", isPrivate: true },
          { id: "C2", name: "general", isPrivate: false },
          { id: "C1", name: "alerts", isPrivate: false },
        ],
        hasPrivateChannelAccess: false,
      },
      isLoading: false,
      error: null,
    };
  });

  it("opens the picker as soon as Slack is connected without a channel", () => {
    renderStep({ result: "connected", reason: null });

    expect(screen.getByText("Which channel should alerts go to?")).toBeDefined();
    const options = within(screen.getByRole("listbox", { name: "Slack channels" }))
      .getAllByRole("option")
      .map((option) => option.textContent);
    // Public channels first, then private, by name.
    expect(options).toEqual(["#alerts", "#general", "#incidentsprivate"]);
    expect(
      screen.getByText(/Private channels show up once the traceroot app is invited/),
    ).toBeDefined();
  });

  it("searches by name, with or without the #", () => {
    renderStep();
    fireEvent.change(screen.getByRole("textbox", { name: "Search channels" }), {
      target: { value: "#gen" },
    });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["#general"]);
  });

  it.each(["pending", "success"] as const)(
    "clears the selection prompt when the channel save is %s",
    (state) => {
      slack.saveState = state;
      renderStep();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(onContinue).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("saves the picked channel for the workspace", () => {
    renderStep();
    fireEvent.click(screen.getByRole("option", { name: "#alerts" }));
    expect(slack.save).toHaveBeenCalledWith(
      { channelId: "C1", channelName: "alerts" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("says why when the channels cannot be loaded", () => {
    slack.channels = { data: undefined, isLoading: false, error: new Error("boom") };
    renderStep();
    expect(screen.getByText(/Couldn't load your Slack channels/)).toBeDefined();
  });

  it("says why when the channel cannot be saved", () => {
    slack.saveError = new Error("Slack refused the channel.");
    renderStep();
    expect(screen.getByRole("alert").textContent).toContain("Slack refused the channel.");
  });

  it("asks for a channel before continuing and still allows an explicit skip", () => {
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Choose a Slack channel");
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip).toHaveBeenCalledOnce();
  });
});

describe("a Slack channel chosen", () => {
  it("continues immediately when the channel is already saved", () => {
    slack.status = { connected: true, teamName: "Acme", channel: { id: "C1", name: "alerts" } };
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says where alerts go, and can change it", async () => {
    slack.status = { connected: true, teamName: "Acme", channel: { id: "C1", name: "alerts" } };
    slack.channels = {
      data: {
        channels: [{ id: "C1", name: "alerts", isPrivate: false }],
        hasPrivateChannelAccess: true,
      },
      isLoading: false,
      error: null,
    };
    renderStep();

    expect(screen.getByText(/Alerts go to/).textContent).toBe("Alerts go to #alerts in Acme");
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() => expect(screen.getByRole("listbox")).toBeDefined());
    expect(screen.getByRole("option", { name: "#alerts" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });
});

describe("a Slack authorization that did not finish", () => {
  it("says why in plain words, and offers to try again, continue or skip", () => {
    renderStep({ result: "error", reason: "access_denied" });

    expect(screen.getByRole("alert").textContent).toBe(
      "Slack wasn't connected: the authorization was cancelled. Try again, or skip and connect it later.",
    );
    const retry = screen.getByRole("link", { name: "Connect Slack" });
    expect(retry.textContent).toBe("Try again");
    expect(new URL(retry.getAttribute("href")!, "http://x").searchParams.get("returnTo")).toBe(
      RETURN_TO,
    );
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("offers no retry when the deployment has no Slack app set up", () => {
    renderStep({ result: "error", reason: "not_configured" });
    expect(screen.getByRole("alert").textContent).toContain("no Slack app set up");
    expect(screen.queryByRole("link", { name: "Connect Slack" })).toBeNull();
    expect(screen.getByRole("link", { name: "Connect GitHub" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("drops the message once a retry has connected Slack", () => {
    slack.status = { connected: true, teamName: "Acme", channel: { id: "C1", name: "alerts" } };
    renderStep({ result: "error", reason: "access_denied" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["exchange_failed", "Slack didn't accept the authorization"],
    ["store_failed", "we couldn't save the connection"],
    ["invalid_state", "the authorization expired or came back incomplete"],
    ["not_configured", "this deployment has no Slack app set up"],
    ["something_else", "Slack wasn't connected. Try again"],
  ])("explains %s", (reason, words) => {
    expect(slackFailureMessage(reason)).toContain(words);
  });
});
