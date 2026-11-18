"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingState } from "@/components/ui/loading-state";
import { ClientMark, MCP_DOCS_URL } from "@/features/oauth-connect";
import { formatRelativeTime } from "@/lib/utils";

interface Connection {
  id: string;
  clientName: string;
  // The host that vouches for the assistant; null when it registered itself.
  verifiedHost?: string | null;
  projectId: string | null;
  projectName: string | null;
  createdAt: string;
}

const QUERY_KEY = ["account-settings", "oauth-connections"] as const;

async function listConnections(): Promise<Connection[]> {
  const response = await fetch("/api/oauth/connections");
  if (!response.ok) throw new Error("Could not load connections");
  return (await response.json()).connections;
}

async function disconnect(id: string): Promise<void> {
  const response = await fetch(`/api/oauth/connections/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error("Could not disconnect. Try again.");
}

// The assistants (Claude, ChatGPT and others) this user has connected to a
// project with a sign-in. Disconnecting removes the grant and its tokens; the
// assistant loses access on its next call, so it asks first.
export function ConnectedAssistants() {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<Connection | null>(null);
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listConnections,
    // Rows name the user's projects; drop them as soon as the page unmounts.
    gcTime: 0,
  });
  const remove = useMutation({
    mutationFn: disconnect,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    onSettled: () => setConfirming(null),
  });
  const connections = query.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Connected assistants</h2>
        <p className="text-sm text-muted-foreground">
          Assistants you have allowed to read a project&apos;s data. Each can read one project and
          cannot change anything. Disconnect one to cut its access at once.
        </p>
      </div>

      {remove.error && (
        <p role="alert" className="text-[13px] text-destructive">
          {remove.error.message}
        </p>
      )}

      {query.isLoading ? (
        <div className="border px-3 py-4">
          <LoadingState label="Loading connections..." />
        </div>
      ) : query.isError ? (
        <div className="border px-3 py-3 text-[13px] text-muted-foreground">
          Couldn&apos;t load your connections. Try refreshing the page.
        </div>
      ) : connections.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="divide-y rounded-md border" aria-label="Connected assistants">
          {connections.map((connection) => (
            <li
              key={connection.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:flex-nowrap"
            >
              <ClientMark
                client={{
                  name: connection.clientName,
                  verifiedHost: connection.verifiedHost ?? null,
                }}
                className="h-8 w-8"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px] font-medium">{connection.clientName}</span>
                  {connection.verifiedHost ? (
                    <Badge variant="success">Verified · {connection.verifiedHost}</Badge>
                  ) : (
                    <Badge variant="warning">Self-registered</Badge>
                  )}
                </div>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  <span className="text-foreground">
                    {connection.projectName ?? "A project that no longer exists"}
                  </span>{" "}
                  · Connected {formatRelativeTime(connection.createdAt)}
                </p>
              </div>
              <Badge variant="outline">Read-only</Badge>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[12px]"
                onClick={() => {
                  remove.reset();
                  setConfirming(connection);
                }}
              >
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setConfirming(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Disconnect {confirming?.clientName}?</DialogTitle>
            <DialogDescription>
              {confirming?.clientName} loses access to{" "}
              <span className="font-medium text-foreground">
                {confirming?.projectName ?? "this project"}
              </span>{" "}
              on its next request, and its tokens are deleted. To use it again, connect it from the
              assistant.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirming(null)}
              disabled={remove.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirming && remove.mutate(confirming.id)}
              disabled={remove.isPending}
            >
              {remove.isPending ? "Disconnecting..." : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center rounded-md border border-dashed px-6 py-8 text-center">
      <Plug className="h-5 w-5 text-muted-foreground" aria-hidden />
      <p className="mt-2 text-[13px] font-medium">No assistants are connected.</p>
      <p className="mt-1 max-w-sm text-[12px] text-muted-foreground">
        Add TraceRoot as an MCP server in Claude, ChatGPT, Cursor or another assistant, and it can
        read one project&apos;s traces after you approve it here.
      </p>
      <a
        href={MCP_DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-3 text-[12px] font-medium underline-offset-4 hover:underline"
      >
        Set up the MCP server
      </a>
    </div>
  );
}
