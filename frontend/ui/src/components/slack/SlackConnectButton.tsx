"use client";

import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { Check, ChevronDown, ExternalLink, Hash, Lock, Send, Settings, Unlink } from "lucide-react";
import { FaSlack } from "react-icons/fa";
import { useWorkspace } from "@/features/workspaces/hooks";
import {
  useSlackStatus,
  useSlackChannels,
  useSaveSlackChannel,
  useDisconnectSlack,
  useSendSlackTest,
} from "@/features/integrations/hooks/useSlackIntegration";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

interface Props {
  workspaceId: string;
}

export function SlackConnectButton({ workspaceId }: Props) {
  const queryClient = useQueryClient();
  const { data: workspace } = useWorkspace(workspaceId);
  const canManage = workspace?.role === "ADMIN";
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [channelOpen, setChannelOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [testFeedback, setTestFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const testFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function flashTestFeedback(kind: "ok" | "err", text: string) {
    if (testFeedbackTimer.current) clearTimeout(testFeedbackTimer.current);
    setTestFeedback({ kind, text });
    testFeedbackTimer.current = setTimeout(() => setTestFeedback(null), 2500);
  }

  const { data, isLoading } = useSlackStatus(workspaceId);
  // Fetch channels when the channel picker is open
  const { data: channelData, isLoading: channelsLoading } = useSlackChannels(
    workspaceId,
    channelOpen,
  );
  const saveChannel = useSaveSlackChannel(workspaceId);
  const disconnect = useDisconnectSlack(workspaceId);
  const testMessage = useSendSlackTest(workspaceId);

  const installHref = `/api/workspaces/${encodeURIComponent(workspaceId)}/slack/install?returnTo=${encodeURIComponent(pathname || "/")}`;

  const sorted = useMemo(() => {
    if (!channelData?.channels) return [];
    return [...channelData.channels].sort((a, b) => {
      if (a.isPrivate !== b.isPrivate) return a.isPrivate ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  }, [channelData]);

  const filtered = useMemo(() => {
    const q = search.trim().replace(/^#/, "").toLowerCase();
    if (!q) return sorted;
    return sorted.filter((c) => c.name.toLowerCase().includes(q));
  }, [sorted, search]);

  const showManualEntry =
    search.startsWith("#") && search.length > 1 && !sorted.some((c) => `#${c.name}` === search);

  const showPrivateScopeHint = channelData?.hasPrivateChannelAccess === false;

  const selectedChannelId = data?.channel?.id;

  function handleSelectChannel(ch: { id: string; name: string }) {
    saveChannel.mutate(
      { channelId: ch.id, channelName: ch.name },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["slack", workspaceId, "status"] });
          setChannelOpen(false);
          setOpen(false);
          setSearch("");
        },
      },
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-between">
        <Row>
          <span className="text-[12px] text-muted-foreground">Loading…</span>
        </Row>
      </div>
    );
  }

  if (data?.connected) {
    const channelLabel = data.channel ? `#${data.channel.name}` : null;
    return (
      <div className="flex items-center justify-between">
        <Row>
          <div>
            <div className="text-sm font-medium">Slack</div>
            <div className="text-sm text-muted-foreground">Post detector alerts to a channel.</div>
            <div className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
              <span>
                Connected to <span className="font-medium text-foreground">{data.teamName}</span>
                {channelLabel && (
                  <>
                    {" · "}
                    {channelLabel}
                  </>
                )}
              </span>
              {canManage && data.channel && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    testMessage.mutate(undefined, {
                      onSuccess: () => flashTestFeedback("ok", "Sent ✓"),
                      onError: (err) =>
                        flashTestFeedback(
                          "err",
                          err instanceof Error ? err.message : "Failed to send test message",
                        ),
                    })
                  }
                  disabled={testMessage.isPending}
                  className="ml-1 gap-1.5 px-2.5"
                  title="Send a test message to this channel"
                >
                  {testMessage.isPending ? (
                    <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  ) : (
                    <Send className="h-3.5 w-3.5 shrink-0" />
                  )}
                  {testMessage.isPending ? "Testing…" : "Test Connection"}
                </Button>
              )}
              {testFeedback && (
                <span
                  className={
                    testFeedback.kind === "ok"
                      ? "ml-1 text-[12px] text-green-600 dark:text-green-500"
                      : "ml-1 text-[12px] text-destructive"
                  }
                >
                  {testFeedback.text}
                </span>
              )}
            </div>
          </div>
        </Row>
        {canManage && (
          <Popover
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              if (!next) {
                setChannelOpen(false);
                setSearch("");
              }
            }}
          >
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1">
                Manage
                <ChevronDown className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-44 p-1">
              {/* Channel item — opens nested channel picker to the right */}
              <Popover
                open={channelOpen}
                onOpenChange={(next) => {
                  setChannelOpen(next);
                  if (!next) setSearch("");
                }}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full select-none items-center gap-2 rounded-sm px-2 py-1 text-[12px] transition-colors hover:bg-accent"
                  >
                    <Settings className="h-3.5 w-3.5 shrink-0" />
                    Configure
                  </button>
                </PopoverTrigger>
                <PopoverContent side="right" align="start" sideOffset={4} className="w-72 p-2">
                  {/* Selected channel summary */}
                  <div className="px-2 pb-2 text-[11px] text-muted-foreground">
                    {channelLabel ? `Posting alerts to ${channelLabel}` : "No channel selected"}
                  </div>

                  {/* Search input */}
                  <input
                    type="text"
                    placeholder="Search or enter #channel-name"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="mb-1 w-full rounded-md border bg-transparent px-2 py-1 text-[12px] outline-none focus:ring-1 focus:ring-ring"
                    autoFocus
                  />

                  {/* Channel list */}
                  <div className="max-h-72 overflow-y-auto rounded-md py-0.5">
                    {channelsLoading && (
                      <div className="px-2 py-1 text-[12px] text-muted-foreground">
                        Loading channels…
                      </div>
                    )}
                    {!channelsLoading && filtered.length === 0 && !showManualEntry && (
                      <div className="px-2 py-1 text-[12px] text-muted-foreground">
                        No channels found.
                      </div>
                    )}
                    {filtered.map((ch) => (
                      <button
                        key={ch.id}
                        type="button"
                        onClick={() => handleSelectChannel({ id: ch.id, name: ch.name })}
                        className="flex w-full select-none items-center rounded-sm px-2 py-1 text-left text-[12px] transition-colors hover:bg-accent"
                      >
                        {ch.isPrivate ? (
                          <Lock className="mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <Hash className="mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="flex-1 truncate">{ch.name}</span>
                        {selectedChannelId === ch.id && (
                          <Check className="ml-2 h-3.5 w-3.5 shrink-0" />
                        )}
                      </button>
                    ))}
                    {showManualEntry && (
                      <button
                        type="button"
                        onClick={() => handleSelectChannel({ id: search, name: search.slice(1) })}
                        className="flex w-full select-none items-center rounded-sm px-2 py-1 text-left text-[12px] transition-colors hover:bg-accent"
                      >
                        Use <span className="ml-1 font-mono">{search}</span>
                      </button>
                    )}
                  </div>

                  {/* Private channel re-auth hint */}
                  {showPrivateScopeHint && (
                    <p className="mt-1 px-2 text-[11px] italic text-muted-foreground">
                      Re-authenticate to grant private-channel access.
                    </p>
                  )}
                </PopoverContent>
              </Popover>

              {/* Disconnect */}
              <button
                type="button"
                onClick={() => {
                  disconnect.mutate();
                  setOpen(false);
                }}
                disabled={disconnect.isPending}
                className="flex w-full select-none items-center gap-2 rounded-sm px-2 py-1 text-[12px] text-destructive transition-colors hover:bg-accent disabled:opacity-50"
              >
                <Unlink className="h-3.5 w-3.5" />
                {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
              </button>
            </PopoverContent>
          </Popover>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between">
      <Row>
        <div>
          <div className="text-sm font-medium">Slack</div>
          <div className="text-sm text-muted-foreground">
            {canManage
              ? "Post detector alerts to a Slack channel."
              : "Slack is not connected. Ask a workspace admin to set it up."}
          </div>
        </div>
      </Row>
      {canManage && (
        <a
          href={installHref}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Connect
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <FaSlack className="h-6 w-6 text-muted-foreground" />
      {children}
    </div>
  );
}
