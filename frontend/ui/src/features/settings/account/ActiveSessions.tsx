"use client";

import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { formatRelativeTime } from "@/lib/utils";
import { useActiveSessions, type SessionRow } from "./hooks";
import { formatSessionAgent } from "./utils/session-label";

export function ActiveSessions() {
  const {
    sessions,
    isLoading,
    isError,
    revoke,
    isRevoking,
    revokingToken,
    revokeOthers,
    isRevokingOthers,
  } = useActiveSessions();

  const hasOtherSessions = sessions.some((session) => !session.isCurrent);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Active sessions</h2>
          <p className="text-sm text-muted-foreground">
            Browser and CLI sessions currently signed in to your account.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => revokeOthers()}
          disabled={!hasOtherSessions || isRevokingOthers}
        >
          {isRevokingOthers ? "Revoking..." : "Revoke all other sessions"}
        </Button>
      </div>

      <div className="border">
        {isLoading ? (
          <div className="px-3 py-4">
            <LoadingState label="Loading sessions..." />
          </div>
        ) : isError ? (
          <div className="px-3 py-3 text-[13px] text-muted-foreground">
            Couldn&apos;t load your sessions. Try refreshing the page.
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-3 py-3 text-[13px] text-muted-foreground">No active sessions.</div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b bg-muted/30 text-left">
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">Device</th>
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">Created</th>
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">
                  Last active
                </th>
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">
                  IP address
                </th>
                <th className="w-28 px-3 py-2 text-[12px] font-medium text-muted-foreground" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <SessionTableRow
                  key={session.id}
                  session={session}
                  onRevoke={() => revoke(session.token)}
                  isRevoking={isRevoking && revokingToken === session.token}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

interface SessionTableRowProps {
  session: SessionRow;
  onRevoke: () => void;
  isRevoking: boolean;
}

function SessionTableRow({ session, onRevoke, isRevoking }: SessionTableRowProps) {
  return (
    <tr className="border-b last:border-b-0 hover:bg-muted/20">
      <td className="px-3 py-2">
        {formatSessionAgent(session.userAgent)}
        {session.isCurrent && (
          <span className="ml-2 border px-1.5 py-0.5 text-[11px] text-muted-foreground">
            This device
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-muted-foreground">{formatRelativeTime(session.createdAt)}</td>
      <td className="px-3 py-2 text-muted-foreground">{formatRelativeTime(session.updatedAt)}</td>
      <td className="px-3 py-2 text-muted-foreground">{session.ipAddress || "-"}</td>
      <td className="px-3 py-2 text-right">
        {/* Revoking your own session logs you out immediately, so the current
            row intentionally offers no plain revoke control — only other
            sessions get a per-row destructive action. */}
        {!session.isCurrent && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[12px]"
            onClick={onRevoke}
            disabled={isRevoking}
          >
            {isRevoking ? "Revoking..." : "Revoke"}
          </Button>
        )}
      </td>
    </tr>
  );
}
