"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { ConnectFrame, PermissionRows } from "@/features/oauth-connect";
import {
  CONTINUE_PATH,
  describeRedirectTarget,
  workspaceSuffix,
  type OAuthClientDisplay,
} from "@/lib/oauth/client-display";

type Selection = { projectName: string; workspaceName: string | null };

// Step two: confirm. The page says who is asking (and who vouches for it), who
// is granting (the signed-in account), exactly what is granted (one project,
// read-only) and where the user is sent next. Allow completes the authorization
// and sends the user back to the assistant; Cancel tells the assistant it was
// refused.
export function ConsentClient({
  client = null,
  accountEmail = null,
  appHost = null,
}: {
  client?: OAuthClientDisplay | null;
  accountEmail?: string | null;
  appHost?: string | null;
}) {
  const searchParams = useSearchParams();
  const clientId = searchParams.get("client_id");
  const returnTo = describeRedirectTarget(searchParams.get("redirect_uri"));

  const [selection, setSelection] = useState<Selection | null | undefined>(undefined);
  const [pending, setPending] = useState<"allow" | "cancel" | "switch" | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId) return;
    fetch("/api/oauth/select-project")
      .then((r) => r.json())
      .then((body) => setSelection(body.selection ?? null))
      .catch(() => setSelection(null));
  }, [clientId]);

  // Back through the authorization: it asks for the project again, and for the
  // account too when the user has signed out first.
  function restartHref() {
    return `${CONTINUE_PATH}?${searchParams.toString()}`;
  }

  async function decide(accept: boolean) {
    setPending(accept ? "allow" : "cancel");
    setError(null);
    try {
      const { data, error: consentError } = await authClient.oauth2.consent({ accept });
      if (consentError || !data?.url) throw new Error("consent failed");
      if (accept) setDone(true);
      window.location.href = data.url;
    } catch {
      setError("Something went wrong. Go back to the assistant and try connecting again.");
      setPending(null);
    }
  }

  async function switchAccount() {
    setPending("switch");
    await authClient.signOut().catch(() => undefined);
    window.location.href = restartHref();
  }

  const name = client?.name ?? "This application";
  const workspace = selection
    ? workspaceSuffix(selection.projectName, selection.workspaceName)
    : null;

  if (done && selection) {
    return (
      <ConnectFrame client={client} title={`${name} is connected`}>
        <div className="space-y-3 text-center" role="status">
          <CheckCircle2
            className="mx-auto h-8 w-8 text-emerald-600 dark:text-emerald-400"
            aria-hidden
          />
          <p className="text-[13px]">
            {name} can now read <strong>{selection.projectName}</strong>.
          </p>
          <p className="text-[12px] text-muted-foreground">
            {returnTo?.opensPage
              ? `Taking you back to ${returnTo.label}…`
              : "You can close this tab and return to the app."}
          </p>
        </div>
      </ConnectFrame>
    );
  }

  return (
    <ConnectFrame client={client} title={`Connect ${name} to TraceRoot`}>
      <div className="space-y-4">
        {accountEmail && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md bg-muted/60 px-3 py-2">
            <span
              aria-hidden
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground text-[11px] font-semibold uppercase text-background"
            >
              {accountEmail.charAt(0)}
            </span>
            <div className="min-w-[10rem] flex-1" data-testid="consent-account">
              <p className="truncate text-[12px] font-medium">{accountEmail}</p>
              {(selection?.workspaceName || appHost) && (
                <p className="truncate text-[11px] text-muted-foreground">
                  {[selection?.workspaceName, appHost].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={switchAccount}
              disabled={pending !== null}
              className="ml-9 shrink-0 text-[12px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline sm:ml-0"
            >
              Not you? Switch account
            </button>
          </div>
        )}

        {client && !client.verifiedHost && (
          <div
            role="alert"
            className="flex gap-2.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
          >
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>
              <span className="font-semibold">Unverified application.</span> &ldquo;{name}&rdquo;
              registered itself, so TraceRoot can&apos;t confirm who made it. Only continue if you
              started this connection from an assistant you trust.
            </p>
          </div>
        )}

        {selection === undefined && (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" />
          </div>
        )}

        {selection === null && (
          <p className="text-center text-[13px]">
            No project is chosen for this connection. Go back to the assistant and connect again.
          </p>
        )}

        {selection && (
          <>
            <div className="flex items-center gap-3 rounded-md border px-3 py-2.5">
              <DOMAIN_ICONS.project
                className="h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] text-muted-foreground">Project</p>
                <p className="truncate text-[13px] font-medium" data-testid="consent-project">
                  {selection.projectName}
                  {workspace && (
                    <span className="font-normal text-muted-foreground"> · {workspace}</span>
                  )}
                </p>
              </div>
              <a
                href={restartHref()}
                className="ml-9 shrink-0 text-[12px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline sm:ml-0"
              >
                Change
              </a>
            </div>

            <div>
              <p className="mb-2 text-[13px] font-medium">{name} will be able to</p>
              <PermissionRows />
            </div>

            <p className="text-[12px] text-muted-foreground">
              You can disconnect it at any time from your account settings.
            </p>

            {error && <p className="text-center text-[12px] text-red-500">{error}</p>}

            <div className="space-y-3 border-t pt-4">
              {returnTo && (
                <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>
                    {returnTo.opensPage ? "You'll be sent to " : "You'll be returned to the "}
                    <span className="font-medium text-foreground">{returnTo.label}</span>
                    {returnTo.opensPage ? "" : " app"}
                  </span>
                </p>
              )}
              <div className="flex flex-col gap-2 sm:flex-row-reverse">
                <Button
                  className="sm:flex-1"
                  disabled={pending !== null}
                  onClick={() => decide(true)}
                >
                  {pending === "allow" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <span className="truncate">
                      Allow {name} to read {selection.projectName}
                    </span>
                  )}
                </Button>
                <Button
                  variant="ghost"
                  className="text-muted-foreground"
                  disabled={pending !== null}
                  onClick={() => decide(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </ConnectFrame>
  );
}
