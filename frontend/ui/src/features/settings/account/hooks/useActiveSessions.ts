"use client";

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";

/** A single row in the Active Sessions table. */
export interface SessionRow {
  id: string;
  token: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** True for the session backing the current request — see ActiveSessions for why it can't be plainly revoked. */
  isCurrent: boolean;
}

const ACTIVE_SESSIONS_QUERY_KEY = ["account-settings", "sessions"] as const;

/**
 * Data-fetching + mutation logic for the Active Sessions table, kept out of
 * the component so it's unit-testable on its own. Wraps three core
 * better-auth client session methods (not a plugin): `listSessions`,
 * `revokeSession`, and `revokeOtherSessions`.
 */
export function useActiveSessions() {
  const queryClient = useQueryClient();

  // The session hook is the supported way to identify "this" session client
  // side; we match its token against each listed row rather than assuming
  // row order or any other positional signal. Mirrors the isPending gating
  // in device-client.tsx: until the current session resolves, we don't know
  // which row is "this device" yet, so no row can be safely offered a plain
  // revoke (a false negative would let the current session's row show one).
  const { data: currentSessionData, isPending: currentSessionPending } = authClient.useSession();
  const currentToken = currentSessionData?.session?.token ?? null;

  const query = useQuery({
    queryKey: ACTIVE_SESSIONS_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await authClient.listSessions();
      if (error) {
        throw new Error(error.message ?? "Failed to load sessions");
      }
      return data ?? [];
    },
  });

  const sessions: SessionRow[] = (query.data ?? []).map((session) => ({
    id: session.id,
    token: session.token,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    // While currentSessionPending, we don't yet know which token is "this
    // device" — `isCurrent` may be a false negative here for the actual
    // current row. Callers must also check `currentSessionPending` before
    // offering a destructive revoke control, not rely on `isCurrent` alone.
    isCurrent: session.token === currentToken,
  }));

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ACTIVE_SESSIONS_QUERY_KEY }),
    [queryClient],
  );

  const revokeMutation = useMutation({
    mutationFn: async (token: string) => {
      // @better-fetch/fetch resolves (doesn't throw) on business-logic
      // failures, so an unchecked `error` here would let a failed revoke
      // still hit onSuccess and silently refresh as if it had worked — on a
      // credential kill switch, that's a false "it's revoked" signal.
      const { error } = await authClient.revokeSession({ token });
      if (error) {
        throw new Error(error.message ?? "Failed to revoke session");
      }
    },
    onSuccess: refresh,
  });

  const revokeOthersMutation = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.revokeOtherSessions();
      if (error) {
        throw new Error(error.message ?? "Failed to revoke other sessions");
      }
    },
    onSuccess: refresh,
  });

  return {
    sessions,
    isLoading: query.isLoading,
    isError: query.isError,
    currentSessionPending,
    revoke: revokeMutation.mutate,
    isRevoking: revokeMutation.isPending,
    revokingToken: (revokeMutation.variables as string | undefined) ?? null,
    revokeError: revokeMutation.error as Error | null,
    revokeOthers: revokeOthersMutation.mutate,
    isRevokingOthers: revokeOthersMutation.isPending,
    revokeOthersError: revokeOthersMutation.error as Error | null,
  };
}
