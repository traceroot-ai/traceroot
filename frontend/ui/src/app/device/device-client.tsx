"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { safeCallbackUrl } from "@/lib/safe-callback-url";
import { formatUserCode } from "@/lib/device-user-code";
import { DEVICE_CLIENT_IDS, DEVICE_CLIENT_NAMES } from "@/lib/auth-clients";
import { mapDeviceErrorMessage, isRecoverableDeviceError } from "./device-error-messages";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/Logo";

const FALLBACK_CLIENT_NAME = "A command-line application";

// Only the plugin's own record of a device code is authoritative on who's
// asking. The `client_id` query param arrives on an unauthenticated GET
// request and isn't checked against that record, so it's just as
// attacker-suppliable as any other query string — reflecting it verbatim
// would let a crafted link put arbitrary text on the consent screen. Only
// resolve a display name for ids in the known allowlist; anything else falls
// back to a generic label instead of parroting unverified text back to the
// user.
function resolveClientDisplayName(clientId: string | null): string {
  if (!clientId || !DEVICE_CLIENT_IDS.has(clientId)) {
    return FALLBACK_CLIENT_NAME;
  }
  return DEVICE_CLIENT_NAMES[clientId] ?? clientId;
}

// The plugin strips hyphens server-side before every lookup, so this is
// purely for a forgiving input (users may paste the "XXXX-XXXX" display
// form, or a mix of cases).
function normalizeCodeInput(raw: string): string {
  return raw.replace(/-/g, "").trim().toUpperCase();
}

type Phase =
  | { kind: "entry" }
  | { kind: "verifying" }
  | { kind: "consent" }
  | { kind: "approved" }
  | { kind: "denied" }
  // `recoverable` gates the "Try again" affordance: only a mistyped/unverified
  // code can be re-entered here, so a locked/expired/used code shows guidance
  // (get a fresh code from the CLI) with no looping retry button.
  | { kind: "error"; message: string; recoverable: boolean };

// Build the sign-in URL that returns to the device consent screen. Carries the
// user_code so the return lands on consent, client_id so it still names the
// client, and any onboarding `next` so a brand-new account continues to
// onboarding after approving (better-auth stores the full callbackUrl — query
// included — in the OAuth state and redirects to it verbatim, so all three
// survive the Google hop). Same-origin-guarded, since user_code comes from the
// entry field. Shared by the effect's signed-out redirect and "Not you? Sign
// out" so the two can't drift.
function deviceSignInUrl(userCode: string, clientId: string | null, next: string | null): string {
  const params = new URLSearchParams({ user_code: userCode });
  if (clientId) {
    params.set("client_id", clientId);
  }
  if (next) {
    params.set("next", next);
  }
  const target = safeCallbackUrl(`/device?${params.toString()}`, "/device");
  return `/auth/sign-in?callbackUrl=${encodeURIComponent(target)}`;
}

function errorPhase(err: Parameters<typeof mapDeviceErrorMessage>[0]): Phase {
  return {
    kind: "error",
    message: mapDeviceErrorMessage(err),
    recoverable: isRecoverableDeviceError(err),
  };
}

// Claim the code for the current session, deferred until the user acts (approve
// or deny). better-auth's verify call (authClient.device) binds the code to the
// current user, and a claimed code can only be approved/denied by that same
// user — so claiming here rather than on page load is what lets "Not you? Sign
// out" hand the still-unclaimed code to a different account. Returns an error
// Phase to display, or null when the code was claimed and is still pending.
async function claimActiveCode(code: string): Promise<Phase | null> {
  const { data, error } = await authClient.device({ query: { user_code: code } });
  if (error) {
    return errorPhase(error);
  }
  if (data && data.status !== "pending") {
    return errorPhase({
      error: "invalid_request",
      error_description: "Device code already processed",
    });
  }
  return null;
}

function DeviceContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: sessionData, isPending: sessionPending } = authClient.useSession();

  const initialCode = normalizeCodeInput(searchParams.get("user_code") ?? "");
  const clientId = searchParams.get("client_id");

  const [codeInput, setCodeInput] = useState(initialCode ? formatUserCode(initialCode) : "");
  const [entryError, setEntryError] = useState<string | null>(null);
  // A code in the URL (the CLI opened the "complete" verification URL, or we're
  // returning from the sign-in round-trip) advances on its own — no manual
  // Continue. The entry form is only for a bare /device visit with no code.
  const [activeCode, setActiveCode] = useState<string | null>(initialCode || null);
  const [phase, setPhase] = useState<Phase>(
    initialCode ? { kind: "verifying" } : { kind: "entry" },
  );
  const [actionPending, setActionPending] = useState(false);

  // Resolve the pending request once we have both a code and a signed-in
  // session. Runs once per (activeCode, session) pair — activeCode only
  // changes when the user (re)submits the entry form, and session identity
  // is keyed off the user id rather than the whole object so a re-render
  // with an equivalent-but-new session object doesn't re-trigger the fetch.
  useEffect(() => {
    if (!activeCode || sessionPending) {
      return;
    }

    if (!sessionData?.user) {
      // Not signed in yet: go to sign-in, carrying the code (+ client_id + any
      // onboarding `next`) back so the return lands on consent and a new account
      // still continues to onboarding.
      router.push(deviceSignInUrl(activeCode, clientId, searchParams.get("next")));
      return;
    }

    // Signed in: show consent WITHOUT verifying yet. Verifying would claim the
    // code for this session (see claimActiveCode), binding it to whoever is
    // already logged in and defeating "Not you? Sign out". The claim happens when
    // the user approves or denies. A stale/expired/already-used code is therefore
    // surfaced at that point instead of on load.
    setPhase({ kind: "consent" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCode, sessionPending, sessionData?.user?.id]);

  function handleSubmitCode() {
    const cleaned = normalizeCodeInput(codeInput);
    if (!cleaned) {
      setEntryError("Enter the code shown in your terminal.");
      return;
    }
    setEntryError(null);
    setActiveCode(cleaned);
  }

  async function handleApprove() {
    if (!activeCode) {
      return;
    }
    setActionPending(true);
    // Claim the code for this session first (deferred from load), then approve.
    const claimError = await claimActiveCode(activeCode);
    if (claimError) {
      setActionPending(false);
      setPhase(claimError);
      return;
    }
    const { error } = await authClient.device.approve({ userCode: activeCode });
    if (error) {
      setActionPending(false);
      setPhase(errorPhase(error));
      return;
    }
    // A signup routes the user here to approve before continuing to onboarding
    // (?next), so hand off there now that the device is authorized. A plain
    // sign-in carries no ?next — the user just returns to their terminal.
    const next = searchParams.get("next");
    if (next) {
      router.push(safeCallbackUrl(next, "/"));
      return;
    }
    setActionPending(false);
    setPhase({ kind: "approved" });
  }

  async function handleDeny() {
    if (!activeCode) {
      return;
    }
    setActionPending(true);
    // Deny also requires the code to be claimed first (same as approve).
    const claimError = await claimActiveCode(activeCode);
    if (claimError) {
      setActionPending(false);
      setPhase(claimError);
      return;
    }
    const { error } = await authClient.device.deny({ userCode: activeCode });
    setActionPending(false);
    if (error) {
      setPhase(errorPhase(error));
      return;
    }
    setPhase({ kind: "denied" });
  }

  function handleStartOver() {
    setActiveCode(null);
    setEntryError(null);
    setCodeInput("");
    setPhase({ kind: "entry" });
  }

  // Signed in as the wrong account. Because the code isn't claimed until the user
  // acts (see claimActiveCode), it's still usable by a different account — so
  // carry it back through sign-in and return to consent as the new account,
  // rather than dropping the flow. Clear activeCode first so signing out doesn't
  // re-fire the effect's signed-out branch mid-flip (we push the sign-in URL,
  // with the code in callbackUrl, explicitly below).
  async function handleSwitchAccount() {
    const code = activeCode;
    setActiveCode(null);
    await authClient.signOut();
    if (!code) {
      router.push("/auth/sign-in");
      return;
    }
    router.push(deviceSignInUrl(code, clientId, searchParams.get("next")));
  }

  return (
    <div className="flex h-full min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mb-2 flex justify-center">
            <Logo size="lg" />
          </div>
          <CardTitle className="text-lg font-semibold">Device sign-in</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {phase.kind === "entry" && (
            <CodeEntry
              value={codeInput}
              onChange={setCodeInput}
              onSubmit={handleSubmitCode}
              error={entryError}
            />
          )}

          {phase.kind === "verifying" && (
            <div className="flex flex-col items-center gap-2 py-6 text-[13px] text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <p>Checking your code...</p>
            </div>
          )}

          {phase.kind === "consent" && activeCode && (
            <Consent
              clientName={resolveClientDisplayName(clientId)}
              email={sessionData?.user?.email ?? null}
              code={activeCode}
              pending={actionPending}
              onApprove={handleApprove}
              onDeny={handleDeny}
              onSwitchAccount={handleSwitchAccount}
            />
          )}

          {phase.kind === "approved" && <Approved />}

          {phase.kind === "denied" && <Denied />}

          {phase.kind === "error" && (
            <ErrorState
              message={phase.message}
              recoverable={phase.recoverable}
              onStartOver={handleStartOver}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

type CodeEntryProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  error: string | null;
};

function CodeEntry({ value, onChange, onSubmit, error }: CodeEntryProps) {
  return (
    <div className="space-y-4">
      <p className="text-center text-[13px] text-muted-foreground">
        Enter the code shown in your terminal to sign in on this device.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="space-y-3"
      >
        <div>
          <label htmlFor="device-code" className="mb-1 block text-[13px] font-medium">
            Device code
          </label>
          <Input
            id="device-code"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="XXXX-XXXX"
            className="h-9 text-center text-[15px] tracking-widest"
            autoFocus
          />
          {error && <p className="mt-1 text-[11px] text-red-500">{error}</p>}
        </div>
        <Button type="submit" size="sm" className="h-8 w-full text-[13px]">
          Continue
        </Button>
      </form>
    </div>
  );
}

type ConsentProps = {
  clientName: string;
  email: string | null;
  code: string;
  pending: boolean;
  onApprove: () => void;
  onDeny: () => void;
  onSwitchAccount: () => void;
};

function Consent({
  clientName,
  email,
  code,
  pending,
  onApprove,
  onDeny,
  onSwitchAccount,
}: ConsentProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-1 text-center">
        <p className="text-[13px]">
          <span className="font-medium">{clientName}</span> wants to sign in
        </p>
        {email && (
          <div className="space-y-0.5 text-[12px] text-muted-foreground">
            <p>as {email}</p>
            <button
              type="button"
              onClick={onSwitchAccount}
              disabled={pending}
              className="underline hover:text-foreground disabled:opacity-50"
            >
              Not you? Sign out
            </button>
          </div>
        )}
      </div>

      <div className="border bg-muted/50 px-3 py-2 text-center">
        <p className="text-[11px] uppercase text-muted-foreground">Confirm this code</p>
        <p className="text-[18px] font-semibold tracking-widest">{formatUserCode(code)}</p>
      </div>

      <p className="text-[12px] text-muted-foreground">
        Approving signs {clientName} in to your TraceRoot account. It stays signed in until you
        revoke it from{" "}
        <Link href="/account/settings/sessions" className="underline hover:text-foreground">
          Active Sessions
        </Link>{" "}
        in your account settings.
      </p>

      <p className="border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
        Only approve a code you generated yourself just now. If you didn&apos;t start a traceroot
        login, deny this.
      </p>

      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-8 flex-1 text-[13px]"
          onClick={onDeny}
          disabled={pending}
        >
          Deny
        </Button>
        <Button size="sm" className="h-8 flex-1 text-[13px]" onClick={onApprove} disabled={pending}>
          {pending ? "Working..." : "Approve"}
        </Button>
      </div>
    </div>
  );
}

function Approved() {
  return (
    <div className="py-4 text-center">
      <p className="text-[14px] font-medium">Approved</p>
      <p className="mt-1 text-[13px] text-muted-foreground">You can return to your terminal.</p>
    </div>
  );
}

function Denied() {
  return (
    <div className="py-4 text-center">
      <p className="text-[14px] font-medium">Denied</p>
      <p className="mt-1 text-[13px] text-muted-foreground">
        This sign-in request was denied. You can close this page.
      </p>
    </div>
  );
}

type ErrorStateProps = {
  message: string;
  recoverable: boolean;
  onStartOver: () => void;
};

function ErrorState({ message, recoverable, onStartOver }: ErrorStateProps) {
  return (
    <div className="space-y-3 py-2 text-center">
      <p className="text-[13px] text-red-600 dark:text-red-400">{message}</p>
      {recoverable && (
        <Button variant="outline" size="sm" className="h-8 text-[13px]" onClick={onStartOver}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function DeviceClient() {
  return (
    <Suspense>
      <DeviceContent />
    </Suspense>
  );
}
