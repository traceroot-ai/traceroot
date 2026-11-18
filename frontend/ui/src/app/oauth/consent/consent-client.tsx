"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/Logo";

type Selection = { projectName: string; workspaceName: string | null };

// Where the user is sent after approving, shown so they can see it is the assistant
// they started from. Any application can register itself under any name, so the
// name above it is not proof of who it is; this is.
function describeReturnTarget(redirectUri: string | null): string | null {
  if (!redirectUri) return null;
  try {
    const url = new URL(redirectUri);
    return url.host ? `${url.protocol}//${url.host}` : url.protocol;
  } catch {
    return null;
  }
}

// Step two: confirm. The page says exactly what is being granted: one project,
// read-only. Allow completes the authorization and sends the user back to the
// assistant; Deny tells the assistant it was refused.
export function ConsentClient() {
  const searchParams = useSearchParams();
  const clientId = searchParams.get("client_id");
  const returnTo = describeReturnTarget(searchParams.get("redirect_uri"));

  const [clientName, setClientName] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId) return;
    authClient.oauth2
      .publicClient({ query: { client_id: clientId } })
      .then(({ data }) => setClientName(data?.client_name ?? null))
      .catch(() => setClientName(null));
    fetch("/api/oauth/select-project")
      .then((r) => r.json())
      .then((body) => setSelection(body.selection ?? null))
      .catch(() => setSelection(null));
  }, [clientId]);

  async function decide(accept: boolean) {
    setPending(true);
    setError(null);
    try {
      const { data, error: consentError } = await authClient.oauth2.consent({ accept });
      if (consentError || !data?.url) throw new Error("consent failed");
      window.location.href = data.url;
    } catch {
      setError("Something went wrong. Go back to the assistant and try connecting again.");
      setPending(false);
    }
  }

  const name = clientName ?? "This application";

  return (
    <div className="flex h-full min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mb-2 flex justify-center">
            <Logo />
          </div>
          <CardTitle className="text-lg font-semibold">Connect {name}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {selection === undefined && (
            <div className="flex justify-center py-6 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}

          {selection === null && (
            <p className="text-center text-[13px]">
              No project is chosen for this connection. Go back to the assistant and connect again.
            </p>
          )}

          {selection && (
            <>
              <p className="text-center text-[13px]">
                Allow <strong>{name}</strong> to read data in{" "}
                <strong>{selection.projectName}</strong>
                {selection.workspaceName ? ` (${selection.workspaceName})` : ""}?
              </p>
              <ul className="list-disc space-y-1 pl-5 text-[12px] text-muted-foreground">
                <li>Read traces, sessions, findings, detectors, alerts, dashboards and datasets</li>
                <li>Run read-only queries on the project&apos;s data</li>
                <li>It cannot change anything, and it cannot see your other projects</li>
              </ul>
              <p className="text-center text-[11px] text-muted-foreground">
                You can disconnect it at any time.
              </p>
              <p className="text-center text-[11px] text-muted-foreground">
                This application registered itself, so TraceRoot has not verified its name.
                {returnTo ? ` After you approve, you are sent to ${returnTo}.` : ""} Only continue
                if you started this connection.
              </p>
              {error && <p className="text-center text-[12px] text-red-500">{error}</p>}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  disabled={pending}
                  onClick={() => decide(false)}
                >
                  Deny
                </Button>
                <Button className="flex-1" disabled={pending} onClick={() => decide(true)}>
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Allow"}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
