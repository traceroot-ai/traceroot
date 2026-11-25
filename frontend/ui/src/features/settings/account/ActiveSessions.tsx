"use client";

import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { formatRelativeTime } from "@/lib/utils";
import { useActiveSessions, type SessionRow } from "./hooks";
import { formatSessionAgent } from "./utils/session-label";
import { useT } from "@/lib/i18n/provider";
import { translateClientError } from "@/lib/i18n/client-errors";

export function ActiveSessions() {
  const t = useT();
  const {
    sessions,
    isLoading,
    isError,
    currentSessionPending,
    revoke,
    isRevoking,
    revokingToken,
    revokeError,
    revokeOthers,
    isRevokingOthers,
    revokeOthersError,
  } = useActiveSessions();

  // Until the current session resolves we don't know which row is "this
  // device", so no destructive control — including revoke-all — is offered
  // yet (see useActiveSessions' isCurrent comment for why).
  const hasOtherSessions = !currentSessionPending && sessions.some((session) => !session.isCurrent);
  const actionError = revokeOthersError ?? revokeError;

  return (
    <div className="space-y-6">
      <div className="-mx-4 -mt-4 flex h-11 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="text-[15px] font-medium">{t("settings.activeSessions")}</h2>
          <p className="text-sm text-muted-foreground">{t("activeSessions.subtitle")}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => revokeOthers()}
          disabled={!hasOtherSessions || isRevokingOthers}
        >
          {isRevokingOthers ? t("activeSessions.revoking") : t("activeSessions.revokeAll")}
        </Button>
      </div>

      {actionError && (
        <p role="alert" className="text-[13px] text-destructive">
          {translateClientError(t, actionError.message)}
        </p>
      )}

      <div className="border">
        {isLoading ? (
          <div className="px-3 py-4">
            <LoadingState label={t("activeSessions.loading")} />
          </div>
        ) : isError ? (
          <div className="px-3 py-3 text-[13px] text-muted-foreground">
            {t("activeSessions.loadError")}
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-3 py-3 text-[13px] text-muted-foreground">
            {t("activeSessions.empty")}
          </div>
        ) : (
          <table className="data-table w-full">
            <thead>
              <tr className="border-b text-left">
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">
                  {t("activeSessions.device")}
                </th>
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">
                  {t("common.created")}
                </th>
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">
                  {t("activeSessions.lastActive")}
                </th>
                <th className="px-3 py-2 text-[12px] font-medium text-muted-foreground">
                  {t("activeSessions.ipAddress")}
                </th>
                <th className="w-28 px-3 py-2 text-[12px] font-medium text-muted-foreground" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <SessionTableRow
                  key={session.id}
                  session={session}
                  canRevoke={!currentSessionPending && !session.isCurrent}
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
  /** False while the current session is unresolved, or for the current row itself. */
  canRevoke: boolean;
  onRevoke: () => void;
  isRevoking: boolean;
}

function SessionTableRow({ session, canRevoke, onRevoke, isRevoking }: SessionTableRowProps) {
  const t = useT();
  return (
    <tr className="border-b last:border-b-0 hover:bg-muted">
      <td className="px-3 py-2">
        {formatSessionAgent(session.userAgent, t)}
        {session.isCurrent && (
          <span className="ml-2 border px-1.5 py-0.5 text-[12px] text-muted-foreground">
            {t("activeSessions.thisDevice")}
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        {formatRelativeTime(session.createdAt, t)}
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        {formatRelativeTime(session.updatedAt, t)}
      </td>
      <td className="px-3 py-2 text-muted-foreground">{session.ipAddress || "-"}</td>
      <td className="px-3 py-2 text-right">
        {/* Revoking your own session logs you out immediately, so the current
            row intentionally offers no plain revoke control — only other
            sessions get a per-row destructive action. Also withheld while
            the current session is still resolving, since until then we
            can't yet rule out this row being the current one. */}
        {canRevoke && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[12px]"
            onClick={onRevoke}
            disabled={isRevoking}
          >
            {isRevoking ? t("activeSessions.revoking") : t("activeSessions.revoke")}
          </Button>
        )}
      </td>
    </tr>
  );
}
