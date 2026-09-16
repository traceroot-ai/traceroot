"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { DENIED_HEADER } from "@/lib/support/policy";
import { SUPPORT_ACTIVE_KEY, clearSupportMarkers, exitImpersonation } from "./exit";

type Context = {
  impersonating: boolean;
  valid?: boolean;
  mode?: string;
  targetEmail?: string;
  expiresAt?: string;
  reason?: string | null;
  workspace?: { id: string; name: string } | null;
};

const CONTEXT_REFRESH_MS = 60_000;
const DENIAL_NOTICE_MS = 6_000;

// Every write the policy refuses is reported here, whichever fetch wrapper the
// feature used. Wrapping `window.fetch` only while a support session is active
// is what lets one place cover all of them; feature code otherwise has no
// consistent error surface (many mutations have no onError at all).
function watchDeniedRequests(onDenied: (message: string) => void) {
  const original = window.fetch;
  window.fetch = async (...args) => {
    const response = await original(...args);
    if (response.status === 403 && response.headers.get(DENIED_HEADER)) {
      response
        .clone()
        .json()
        .then((body) => onDenied(body?.error ?? "Not allowed while impersonating"))
        .catch(() => onDenied("Not allowed while impersonating"));
    }
    return response;
  };
  return () => {
    window.fetch = original;
  };
}

export function ImpersonationBanner() {
  const { data, isPending } = authClient.useSession();
  const pathname = usePathname();
  const [context, setContext] = useState<Context | null>(null);
  const [active, setActive] = useState(false);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0);
  const impersonatedBy = data?.session?.impersonatedBy;
  useEffect(() => {
    const suspected = !!impersonatedBy || sessionStorage.getItem(SUPPORT_ACTIVE_KEY) === "true";
    setActive(suspected);
    if (!suspected) return;
    let disposed = false;
    const update = async () => {
      if (document.visibilityState === "hidden") return;
      setNow(Date.now());
      try {
        const params = new URLSearchParams({ view: "context" });
        const match = pathname.match(/^\/(workspaces|projects)\/([^/]+)/);
        if (match) params.set(match[1] === "workspaces" ? "workspaceId" : "projectId", match[2]);
        const response = await fetch(`/api/support?${params}`);
        if (response.ok && !disposed) setContext(await response.json());
      } catch {
        /* Keep the exit control available during an outage. */
      }
    };
    void update();
    const interval = setInterval(update, CONTEXT_REFRESH_MS);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    return () => {
      disposed = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
    };
  }, [impersonatedBy, pathname]);
  useEffect(() => {
    if (!active || restored) return;
    return watchDeniedRequests(setDenied);
  }, [active, restored]);
  useEffect(() => {
    if (!denied) return;
    const timer = setTimeout(() => setDenied(""), DENIAL_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [denied]);
  // The server already unwound this session (see /api/auth get-session): the
  // cookie now holds the employee login, so there is nothing left to exit.
  useEffect(() => {
    if (active && !isPending && !impersonatedBy && context && !context.impersonating) {
      clearSupportMarkers();
      setRestored(true);
    }
  }, [active, isPending, impersonatedBy, context]);
  if (!active) return null;
  if (restored)
    return (
      <div
        role="status"
        className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100"
      >
        <div>
          <span className="font-semibold">Support session ended.</span> You are back on your
          employee account.
        </div>
        <div className="flex gap-2">
          <Link href="/admin" className="text-sm font-medium underline underline-offset-2">
            Support console
          </Link>
          <Button size="sm" variant="ghost" onClick={() => setActive(false)}>
            Dismiss
          </Button>
        </div>
      </div>
    );
  const expired =
    context &&
    (!context.impersonating ||
      !context.valid ||
      (context.expiresAt && new Date(context.expiresAt).getTime() <= now));
  const notice = error || denied;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          <span className="font-semibold">{expired ? "Support session ended" : "Viewing as"}</span>{" "}
          {context?.targetEmail ?? data?.user.email}
        </span>
        <span
          className="rounded border border-amber-400/60 px-1.5 py-px text-xs"
          title={
            context?.mode === "read-write"
              ? "Admin session: changes are allowed and audited"
              : "Support session: you can look but not change anything"
          }
        >
          {context?.mode === "read-write" ? "Read + write" : "Read-only"}
        </span>
        {context?.workspace && (
          <span title={context.workspace.id}>Workspace: {context.workspace.name}</span>
        )}
        {context?.reason && (
          <span
            className="max-w-xs truncate text-amber-800 dark:text-amber-300"
            title={context.reason}
          >
            Reason: {context.reason}
          </span>
        )}
        {notice && (
          <span
            role="alert"
            className="rounded bg-amber-200 px-1.5 py-px font-medium dark:bg-amber-900"
          >
            {notice}
          </span>
        )}
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await exitImpersonation();
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        }}
      >
        Exit impersonation
      </Button>
    </div>
  );
}
