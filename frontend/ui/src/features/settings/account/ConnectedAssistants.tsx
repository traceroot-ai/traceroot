"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { formatRelativeTime } from "@/lib/utils";

interface Connection {
  id: string;
  clientName: string;
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
// assistant loses access on its next call.
export function ConnectedAssistants() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listConnections,
    // Rows name the user's projects; drop them as soon as the page unmounts.
    gcTime: 0,
  });
  const remove = useMutation({
    mutationFn: disconnect,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
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

      <div className="border">
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
            No assistants are connected.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b bg-muted/30 text-left">
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">
                  Assistant
                </th>
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">Project</th>
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">
                  Connected
                </th>
                <th className="w-28 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {connections.map((connection) => (
                <tr key={connection.id} className="border-b last:border-b-0 hover:bg-muted/20">
                  <td className="px-3 py-2">{connection.clientName}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {connection.projectName ?? "A project that no longer exists"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatRelativeTime(connection.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-[12px]"
                      onClick={() => remove.mutate(connection.id)}
                      disabled={remove.isPending && remove.variables === connection.id}
                    >
                      {remove.isPending && remove.variables === connection.id
                        ? "Disconnecting..."
                        : "Disconnect"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
