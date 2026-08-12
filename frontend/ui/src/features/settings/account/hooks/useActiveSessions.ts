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
  // row order or any other positional signal.
  const { data: currentSessionData } = authClient.useSession();
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
    isCurrent: session.token === currentToken,
  }));

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ACTIVE_SESSIONS_QUERY_KEY }),
    [queryClient],
  );

  const revokeMutation = useMutation({
    mutationFn: (token: string) => authClient.revokeSession({ token }),
    onSuccess: refresh,
  });

  const revokeOthersMutation = useMutation({
    mutationFn: () => authClient.revokeOtherSessions(),
    onSuccess: refresh,
  });

  return {
    sessions,
    isLoading: query.isLoading,
    isError: query.isError,
    revoke: revokeMutation.mutate,
    isRevoking: revokeMutation.isPending,
    revokingToken: (revokeMutation.variables as string | undefined) ?? null,
    revokeOthers: revokeOthersMutation.mutate,
    isRevokingOthers: revokeOthersMutation.isPending,
  };
}
