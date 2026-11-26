"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FaGithub } from "react-icons/fa";
import { Check } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { SlackLogo } from "@/components/slack/SlackLogo";
import { slackInstallHref } from "@/components/slack/SlackConnectButton";
import { githubConnectHref } from "@/components/github/GitHubConnectButton";
import {
  useSaveSlackChannel,
  useSlackChannels,
  useSlackStatus,
} from "@/features/integrations/hooks/useSlackIntegration";
import { useWorkspace } from "@/features/workspaces/hooks";
import { fetchGitHubConnection } from "@/lib/github";
import { cn } from "@/lib/utils";

/**
 * What a failed or cancelled Slack authorization comes back with
 * (`slack=error&reason=…`, app/api/slack/oauth/callback), in plain words.
 */
export function slackFailureMessage(reason: string | null): string {
  switch (reason) {
    case "access_denied":
      return "Slack wasn't connected: the authorization was cancelled. Try again, or skip and connect it later.";
    case "exchange_failed":
      return "Slack wasn't connected: Slack didn't accept the authorization. Try again, or skip and connect it later.";
    case "store_failed":
      return "Slack wasn't connected: we couldn't save the connection. Try again, or skip and connect it later.";
    case "not_configured":
      return "Slack can't be connected here yet: this deployment has no Slack app set up. Skip for now; an admin can connect it later in Workspace settings → Integrations.";
    case "invalid_state":
    case "missing_params":
      return "Slack wasn't connected: the authorization expired or came back incomplete. Try again, or skip and connect it later.";
    default:
      return "Slack wasn't connected. Try again, or skip and connect it later.";
  }
}

interface ConnectStepProps {
  workspaceId: string;
  /** This step's own address, where both authorizations come back to. */
  returnTo: string;
  /** The `slack=…` outcome and its reason, as the callback left them on the address. */
  slackOutcome: { result: string | null; reason: string | null };
  /** `github=unavailable` on the address: a connection that could not start here. */
  githubOutcome?: string | null;
  /** Continue and "Skip for now": both go on to the setup command. */
  onContinue: () => void;
  onSkip: () => void;
}

/**
 * The sign-up step that connects GitHub and Slack to the new workspace, after it
 * and its project exist and before the setup command. Both are optional.
 *
 * The flows are the ones workspace settings use; this step only starts them and
 * is where they come back to. Slack needs one thing more here: a channel. A
 * connection without one drops every alert, and authorization no longer lands on
 * settings, where the channel used to be picked, so the picker opens under the
 * Slack row as soon as it is connected.
 */
export function ConnectStep({
  workspaceId,
  returnTo,
  slackOutcome,
  githubOutcome = null,
  onContinue,
  onSkip,
}: ConnectStepProps) {
  const { data: github } = useQuery({
    queryKey: ["github-connection", workspaceId],
    queryFn: () => fetchGitHubConnection(workspaceId),
    enabled: !!workspaceId,
  });
  const { data: slack, isLoading: slackLoading } = useSlackStatus(workspaceId);
  // Connecting changes the workspace for everyone in it, so it is for its admins;
  // the person who just created the workspace is one.
  const { data: workspace } = useWorkspace(workspaceId);
  const canManage = workspace?.role === "ADMIN";
  const [changingChannel, setChangingChannel] = useState(false);

  // No GitHub App set up on this deployment (no client id or app name): GitHub
  // could only show an error page, so the row says so and offers nothing.
  const githubUnavailable =
    !github?.connected && (github?.available === false || githubOutcome === "unavailable");
  const slackFailed = slackOutcome.result === "error" && !slack?.connected;
  // Trying again cannot work until the deployment has a Slack app set up.
  const slackUnavailable = slackFailed && slackOutcome.reason === "not_configured";
  const pickingChannel = !!slack?.connected && (!slack.channel || changingChannel);

  return (
    <div className="flex flex-col gap-4">
      {slackFailed && (
        <p
          role="alert"
          className="border border-danger-border bg-danger-soft p-3 text-[12px] text-danger"
        >
          {slackFailureMessage(slackOutcome.reason)}
        </p>
      )}

      <div className="divide-y divide-border rounded-[4px] border border-border">
        <Row
          icon={<FaGithub className="h-4 w-4" />}
          name="GitHub"
          detail={
            github?.connected
              ? `Connected to ${github.installations.map((i) => i.accountLogin).join(", ")}`
              : githubUnavailable
                ? "Not available on this deployment yet. Continue without it."
                : "Link findings to your code"
          }
          action={
            github?.connected ? (
              <Connected />
            ) : githubUnavailable ? (
              <span className="text-[12px] text-muted-foreground">Unavailable</span>
            ) : !canManage ? (
              <AdminsOnly />
            ) : (
              <ConnectLink href={githubConnectHref(workspaceId, returnTo)} label="Connect GitHub">
                Connect
              </ConnectLink>
            )
          }
        />
        <Row
          icon={<SlackLogo className="h-4 w-4" />}
          name="Slack"
          detail={
            slack?.connected ? (
              slack.channel && !changingChannel ? (
                <>
                  Alerts go to{" "}
                  <span className="font-medium text-foreground">#{slack.channel.name}</span> in{" "}
                  {slack.teamName}
                </>
              ) : (
                <>
                  Connected to <span className="font-medium text-foreground">{slack.teamName}</span>
                </>
              )
            ) : (
              "Send project alerts to a Slack channel"
            )
          }
          action={
            slackLoading ? null : slack?.connected ? (
              <span className="flex items-center gap-3">
                {slack.channel && !changingChannel && (
                  <button
                    type="button"
                    onClick={() => setChangingChannel(true)}
                    className="text-[12px] underline underline-offset-4"
                  >
                    Change
                  </button>
                )}
                <Connected />
              </span>
            ) : !canManage ? (
              <AdminsOnly />
            ) : slackUnavailable ? null : (
              <ConnectLink href={slackInstallHref(workspaceId, returnTo)} label="Connect Slack">
                {slackFailed ? "Try again" : "Connect"}
              </ConnectLink>
            )
          }
        />
        {pickingChannel && canManage && (
          <ChannelPicker
            workspaceId={workspaceId}
            selectedId={slack?.channel?.id}
            onSaved={() => setChangingChannel(false)}
          />
        )}
      </div>

      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={onContinue}
          className={cn(buttonVariants({ size: "sm" }), "h-8 w-full text-[13px]")}
        >
          Continue
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="text-[12px] text-muted-foreground hover:text-foreground"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}

function Row({
  icon,
  name,
  detail,
  action,
}: {
  icon: ReactNode;
  name: string;
  detail: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] border border-border bg-background">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{name}</p>
        <p className="break-words text-[12px] text-muted-foreground">{detail}</p>
      </div>
      <div className="ml-auto shrink-0">{action}</div>
    </div>
  );
}

function AdminsOnly() {
  return (
    <span className="text-[12px] text-muted-foreground">Workspace admins can connect this</span>
  );
}

function Connected() {
  return (
    <span className="flex items-center gap-1.5 text-[12px] font-medium text-primary">
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary">
        <Check className="h-2.5 w-2.5 text-primary-foreground" strokeWidth={3} />
      </span>
      Connected
    </span>
  );
}

function ConnectLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      aria-label={label}
      className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-7 px-3 text-[12px]")}
    >
      {children}
    </a>
  );
}

/**
 * Which channel alerts go to: the workspace's channels from Slack, searched by
 * name, public before private. Only a listed channel can be picked; saving one is
 * what settings does too.
 */
function ChannelPicker({
  workspaceId,
  selectedId,
  onSaved,
}: {
  workspaceId: string;
  selectedId: string | undefined;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const { data, isLoading, error } = useSlackChannels(workspaceId, true);
  const save = useSaveSlackChannel(workspaceId);

  const channels = useMemo(() => {
    const query = search.trim().replace(/^#/, "").toLowerCase();
    return [...(data?.channels ?? [])]
      .sort((a, b) =>
        a.isPrivate !== b.isPrivate ? (a.isPrivate ? 1 : -1) : a.name.localeCompare(b.name),
      )
      .filter((channel) => !query || channel.name.toLowerCase().includes(query));
  }, [data, search]);

  return (
    <div className="bg-muted/40 py-2.5 pl-[52px] pr-3">
      <p className="mb-1.5 text-[12px] font-medium">Which channel should alerts go to?</p>
      <input
        type="text"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search channels"
        aria-label="Search channels"
        className="h-7 w-full rounded-[3px] border border-border bg-background px-2 text-[12px] outline-none focus:border-ring"
      />
      <div
        role="listbox"
        aria-label="Slack channels"
        className="mt-1.5 max-h-44 overflow-y-auto rounded-[3px] border border-border bg-background"
      >
        {isLoading ? (
          <p className="px-2 py-1.5 text-[12px] text-muted-foreground">Loading channels…</p>
        ) : error ? (
          <p className="px-2 py-1.5 text-[12px] text-danger">
            Couldn&apos;t load your Slack channels. Try again, or pick one later in workspace
            settings.
          </p>
        ) : channels.length === 0 ? (
          <p className="px-2 py-1.5 text-[12px] text-muted-foreground">No channel matches.</p>
        ) : (
          channels.map((channel) => (
            <button
              key={channel.id}
              type="button"
              role="option"
              aria-selected={channel.id === selectedId}
              disabled={save.isPending}
              onClick={() =>
                save.mutate(
                  { channelId: channel.id, channelName: channel.name },
                  {
                    onSuccess: () => {
                      queryClient.invalidateQueries({ queryKey: ["slack", workspaceId, "status"] });
                      onSaved();
                    },
                  },
                )
              }
              className={cn(
                "flex w-full items-center gap-1.5 border-b border-border px-2 py-1.5 text-left text-[12px] last:border-b-0 hover:bg-muted",
                channel.id === selectedId && "bg-accent",
              )}
            >
              <span className="text-muted-foreground">#</span>
              {channel.name}
              {channel.isPrivate && (
                <span className="ml-auto text-[11px] text-muted-foreground">private</span>
              )}
            </button>
          ))
        )}
      </div>
      {save.error && (
        <p role="alert" className="mt-1.5 text-[12px] text-danger">
          {save.error instanceof Error ? save.error.message : "Couldn't save the channel."} Try
          another, or pick one later in workspace settings.
        </p>
      )}
      <p className="mt-1.5 text-[11.5px] text-muted-foreground">
        Pick a channel from the list.
        {data?.hasPrivateChannelAccess === false &&
          " Private channels show up once the traceroot app is invited to them."}
      </p>
    </div>
  );
}
