"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { AccountLine } from "@/components/account-line";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/Logo";
import { ClientVerifiedBy, UnverifiedClientNotice } from "@/features/oauth-connect";
import {
  CONTINUE_PATH,
  describeRedirectTarget,
  workspaceSuffix,
  type OAuthClientDisplay,
} from "@/lib/oauth/client-display";

type Selection = { projectName: string; workspaceName: string | null };

// What the mcp:read scope lets an assistant read in the chosen project.
const READABLE = "Traces and sessions, findings, detectors, alerts, dashboards, datasets and SQL";

// Step two: confirm. The page says who is asking (and who vouches for it), who
// is granting (the signed-in account), exactly what is granted (one project,
// read-only) and where the user is sent next. Allow completes the authorization
// and sends the user back to the assistant; Cancel tells the assistant it was
// refused.
export function ConsentClient({
  client = null,
  accountEmail = null,
}: {
  client?: OAuthClientDisplay | null;
  accountEmail?: string | null;
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

  // Signed in as the wrong account: sign out, then restart the same
  // authorization, which asks for an account again.
  async function switchAccount() {
    setPending("switch");
    setError(null);
    let cleared: boolean;
    try {
      const { error: signOutError } = await authClient.signOut();
      cleared = !signOutError;
    } catch {
      cleared = false;
    }
    if (!cleared) {
      setError("Could not sign out, so you are still signed in. Try again.");
      setPending(null);
      return;
    }
    window.location.href = restartHref();
  }

  const name = client?.name ?? "This application";
  const workspace = selection
    ? workspaceSuffix(selection.projectName, selection.workspaceName)
    : null;

  return (
    <div className="flex h-full min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mb-2 flex justify-center">
            <Logo size="lg" />
          </div>
          <CardTitle className="text-[15px] font-medium">
            {done ? `${name} is connected` : `Connect ${name} to traceroot`}
          </CardTitle>
          <ClientVerifiedBy client={client} />
        </CardHeader>
        <CardContent className="space-y-4">
          {done && selection ? (
            <div role="status" className="py-4 text-center">
              <p className="text-[13px]">
                {name} can now read <span className="font-medium">{selection.projectName}</span>.
              </p>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {returnTo?.opensPage
                  ? `Taking you back to ${returnTo.label}...`
                  : "You can close this tab and return to the app."}
              </p>
            </div>
          ) : (
            <>
              <AccountLine
                email={accountEmail}
                pending={pending !== null}
                onSwitchAccount={switchAccount}
              />

              <UnverifiedClientNotice client={client} />

              {selection === undefined && (
                <div className="flex flex-col items-center gap-2 py-6 text-[13px] text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <p>Loading...</p>
                </div>
              )}

              {selection === null && (
                <p className="py-2 text-center text-[13px] text-muted-foreground">
                  No project is chosen for this connection. Go back to the assistant and connect
                  again.
                </p>
              )}

              {selection && (
                <>
                  <dl className="border text-[12px]">
                    <Row label="Project">
                      <span className="flex items-start justify-between gap-3">
                        <span className="min-w-0 break-words" data-testid="consent-project">
                          <span className="font-medium text-foreground">
                            {selection.projectName}
                          </span>
                          {workspace && (
                            <span className="text-muted-foreground"> · {workspace}</span>
                          )}
                        </span>
                        <a
                          href={restartHref()}
                          className="shrink-0 text-muted-foreground underline hover:text-foreground"
                        >
                          Change
                        </a>
                      </span>
                    </Row>
                    <Row label="Access">
                      <span className="font-medium text-foreground">Read-only.</span> Can&apos;t
                      change anything or see other projects.
                    </Row>
                    <Row label="Can read">{READABLE}</Row>
                    {returnTo && (
                      <Row label="Returns to">
                        <span className="break-all font-medium text-foreground">
                          {returnTo.label}
                        </span>
                        {returnTo.opensPage ? "" : " app"}
                      </Row>
                    )}
                  </dl>

                  <p className="text-[12px] text-muted-foreground">
                    You can disconnect {name} at any time from{" "}
                    <Link
                      href="/account/settings/connections"
                      className="underline hover:text-foreground"
                    >
                      Connected assistants
                    </Link>{" "}
                    in your account settings.
                  </p>

                  {error && (
                    <div className="border border-danger-border bg-danger-soft p-3 text-[12px] text-danger">
                      {error}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-[13px]"
                      disabled={pending !== null}
                      onClick={() => decide(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className="h-8 min-w-0 flex-1 text-[13px]"
                      disabled={pending !== null}
                      onClick={() => decide(true)}
                    >
                      <span className="truncate">
                        {pending === "allow"
                          ? "Connecting..."
                          : `Allow ${name} to read ${selection.projectName}`}
                      </span>
                    </Button>
                  </div>
                </>
              )}

              {error && !selection && (
                <div className="border border-danger-border bg-danger-soft p-3 text-[12px] text-danger">
                  {error}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 border-b px-3 py-2 last:border-b-0">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-muted-foreground">{children}</dd>
    </div>
  );
}
