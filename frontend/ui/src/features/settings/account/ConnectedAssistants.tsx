"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { MCP_DOCS_URL } from "@/features/oauth-connect";
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
      <div className="-mx-4 -mt-4 flex h-11 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="text-[15px] font-medium">Connected assistants</h2>
          <p className="truncate text-sm text-muted-foreground">
            Assistants with read-only access to one of your projects.
          </p>
        </div>
      </div>

      {remove.error && (
        <p role="alert" className="text-[13px] text-destructive">
          {remove.error.message}
        </p>
      )}

      <div className="overflow-x-auto border">
        {query.isLoading ? (
          <div className="px-3 py-4">
            <LoadingState label="Loading connections..." />
          </div>
        ) : query.isError ? (
          <div className="px-3 py-3 text-[13px] text-muted-foreground">
            Couldn&apos;t load your connections. Try refreshing the page.
          </div>
        ) : connections.length === 0 ? (
          <div className="px-3 py-3 text-[13px] text-muted-foreground">
            <span>No assistants are connected.</span>{" "}
            <a
              href={MCP_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-foreground"
            >
              Set up the MCP server
            </a>{" "}
            in Claude, ChatGPT, Cursor or another assistant to let it read a project.
          </div>
        ) : (
          <table className="data-table w-full">
            <thead>
              <tr className="border-b text-left">
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">
                  Assistant
                </th>
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">Project</th>
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">
                  Verified by
                </th>
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">
                  Connected
                </th>
                <th className="w-28 px-3 py-2 text-[12px] font-medium text-muted-foreground" />
              </tr>
            </thead>
            <tbody>
              {connections.map((connection) => (
                <tr key={connection.id} className="border-b last:border-b-0 hover:bg-muted">
                  <td className="px-3 py-2">{connection.clientName}</td>
                  <td className="px-3 py-2">
                    {connection.projectName ?? (
                      <span className="text-muted-foreground">Deleted project</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {connection.verifiedHost ?? "Self-registered"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatRelativeTime(connection.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-right">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setConfirming(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {confirming?.clientName}</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            {confirming?.clientName} loses access to{" "}
            <span className="font-medium text-foreground">
              {confirming?.projectName ?? "this project"}
            </span>{" "}
            on its next request, and its tokens are deleted. To use it again, connect it from the
            assistant.
          </DialogDescription>
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
