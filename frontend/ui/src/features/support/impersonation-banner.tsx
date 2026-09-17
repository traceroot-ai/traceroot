"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { UserRoundSearch } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { DENIED_HEADER } from "@/lib/support/policy";
import { cn } from "@/lib/utils";
import { SUPPORT_ACTIVE_KEY, clearSupportMarkers, exitImpersonation } from "./exit";

type Context = {
  impersonating: boolean;
  valid?: boolean;
  mode?: string;
  targetEmail?: string;
  expiresAt?: string;
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

export function ImpersonationBanner({ collapsed = false }: { collapsed?: boolean }) {
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
    setContext(null);
    if (impersonatedBy) setRestored(false);
    if (!suspected || isPending) return;
    let disposed = false;
    let revision = 0;
    const controller = new AbortController();
    const update = async () => {
      if (document.visibilityState === "hidden") return;
      setNow(Date.now());
      const currentRevision = ++revision;
      try {
        const params = new URLSearchParams({ view: "context" });
        const match = pathname.match(/^\/(workspaces|projects)\/([^/]+)/);
        if (match) params.set(match[1] === "workspaces" ? "workspaceId" : "projectId", match[2]);
        const response = await fetch(`/api/support?${params}`, { signal: controller.signal });
        if (response.ok) {
          const next = await response.json();
          if (!disposed && currentRevision === revision) setContext(next);
        }
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
      controller.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
    };
  }, [impersonatedBy, pathname, isPending, data?.session?.id]);
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
    if (
      active &&
      !isPending &&
      data?.session &&
      !impersonatedBy &&
      context &&
      !context.impersonating
    ) {
      clearSupportMarkers();
      setRestored(true);
    }
  }, [active, isPending, impersonatedBy, context, data?.session]);
  if (!active) return null;
  const expired =
    context &&
    (!context.impersonating ||
      !context.valid ||
      (context.expiresAt && new Date(context.expiresAt).getTime() <= now));
  const notice = error || denied;
  const target = context?.targetEmail ?? data?.user.email ?? "customer";
  const ended = restored || !!expired;
  const label = ended ? "Support session ended" : notice || target;
  const action = ended ? "Back" : "Stop";
  const handleAction = async () => {
    if (restored) {
      clearSupportMarkers();
      setActive(false);
      window.location.assign("/admin");
      return;
    }
    setBusy(true);
    try {
      await exitImpersonation();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div
      role="status"
      title={
        collapsed ? `${ended ? "Support session ended" : "Impersonating"}: ${target}` : undefined
      }
      className={cn(
        "flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30",
        collapsed ? "justify-center px-2 py-2" : "px-3 py-2",
      )}
    >
      {collapsed ? (
        <button
          type="button"
          aria-label={`${action} impersonation for ${target}`}
          disabled={busy}
          onClick={handleAction}
        >
          <UserRoundSearch className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
        </button>
      ) : (
        <>
          <UserRoundSearch className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span
            role={notice ? "alert" : undefined}
            className="min-w-0 flex-1 truncate text-[13px] text-amber-800 dark:text-amber-300"
            title={label}
          >
            {label}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-md border border-amber-300 bg-white px-1.5 py-0.5 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:bg-transparent dark:text-amber-400 dark:hover:bg-amber-900/50"
            disabled={busy}
            onClick={handleAction}
          >
            {action}
          </button>
        </>
      )}
    </div>
  );
}
