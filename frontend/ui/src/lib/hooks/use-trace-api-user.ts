import { useSession as useAuthSession } from "@/lib/auth-client";
import type { TraceApiUser } from "@/lib/api/client";

/**
 * Session-derived identity for trace-api calls: `user` for the request
 * headers and `sessionReady` to gate queries until auth has resolved.
 */
export function useTraceApiUser(): { user: TraceApiUser | undefined; sessionReady: boolean } {
  const { data: authSession, isPending } = useAuthSession();
  const sessionReady = !isPending && !!authSession?.user;
  const user = authSession?.user
    ? { id: authSession.user.id, email: authSession.user.email }
    : undefined;
  return { user, sessionReady };
}
