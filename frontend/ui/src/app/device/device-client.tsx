"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { getWorkspaces } from "@/lib/api/workspaces";
import type { TraceApiUser } from "@/lib/api/client";
import type { Workspace } from "@/types/api";
import { traceUrl } from "@/lib/first-trace";
import type { TraceWait } from "@/lib/hooks/use-trace-wait";
import { useFirstTraceWait } from "./use-first-trace-wait";
import { resolveSetupNeed, onboardingUrlForSetup, type SetupNeed } from "@/lib/account-setup";
import { safeCallbackUrl } from "@/lib/safe-callback-url";
import { formatUserCode } from "@/lib/device-user-code";
import { DEVICE_CLIENT_IDS, DEVICE_CLIENT_NAMES } from "@/lib/auth-clients";
import { mapDeviceErrorMessage, isRecoverableDeviceError } from "./device-error-messages";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/Logo";
import { AccountLine } from "@/components/account-line";
import { FirstTraceLine } from "@/components/first-trace-line";

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
  // Signed in, but the account cannot serve the CLI yet. Approval is withheld;
  // denial is not (see SetupRequired).
  | { kind: "setup"; need: SetupNeed }
  | { kind: "consent" }
  // The terminal is released. The panel stays put and starts watching for the
  // run's first trace, so this one phase renders three outcomes — still
  // waiting, settled on a trace, finished without one — carried by the
  // `TraceWait` the watch returns rather than by three phases of its own.
  // Whichever it is, approval is already complete and cannot be taken back.
  | { kind: "approved" }
  | { kind: "denied" }
  // `recoverable` gates the "Try again" affordance: only a mistyped/unverified
  // code can be re-entered here, so a locked/expired/used code shows guidance
  // (get a fresh code from the CLI) with no looping retry button.
  | { kind: "error"; message: string; recoverable: boolean };

// This page's own URL, carrying the user_code so a return lands on consent
// rather than the entry form, and client_id so it still names the client.
// Same-origin-guarded, since user_code comes from the entry field.
function deviceReturnUrl(userCode: string, clientId: string | null): string {
  const params = new URLSearchParams({ user_code: userCode });
  if (clientId) {
    params.set("client_id", clientId);
  }
  return safeCallbackUrl(`/device?${params.toString()}`, "/device");
}

// Sign-in, returning here afterwards. better-auth stores the whole callbackUrl
// — query included — in the OAuth state and redirects to it verbatim, so the
// code survives the Google hop. Shared by the effect's signed-out redirect and
// "Not you? Sign out" so the two cannot drift.
function deviceSignInUrl(userCode: string, clientId: string | null): string {
  return `/auth/sign-in?callbackUrl=${encodeURIComponent(deviceReturnUrl(userCode, clientId))}`;
}

// Onboarding, returning here afterwards.
//
// This is the only place the project requirement can be enforced for every way
// in. Routing sign-*up* through onboarding is not enough: this page sends a
// signed-out visitor to sign-*in*, and better-auth has no separate social
// sign-up — `signIn.social` creates the account on first use, which
// `signupProvider()` in lib/signup/on-user-created.ts classifies as a signup by
// looking for `/callback/<provider>`. So clicking Google on the page this one
// hands people to *is* the default new-account path, and it used to arrive back
// here owning nothing. Checking the account instead of trusting the route it
// took covers sign-up, sign-in, social and an already-authenticated session
// alike — and it is also the only way to catch an *existing* account that owns
// a workspace with no project in it.
//
// An account that already has the workspace goes to onboarding's project-only
// mode (`?workspaceId=`), which asks for the one thing that is missing instead
// of offering a second workspace nobody asked for. Both the need and the
// destination come from lib/account-setup, which onboarding reads too — the two
// pages disagreeing about what "set up" means is a loop, not a redirect.
function deviceOnboardingUrl(need: SetupNeed, userCode: string, clientId: string | null): string {
  return onboardingUrlForSetup(need, deviceReturnUrl(userCode, clientId));
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
  // Kept from the gate below rather than re-fetched after approval: these are
  // the only places the authorized run's trace could land, and the browser is
  // not allowed to add to them.
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);

  const traceUser: TraceApiUser | undefined = sessionData?.user?.id
    ? { id: sessionData.user.id, email: sessionData.user.email }
    : undefined;

  // Starts only once the terminal has been released, and reads only. A tab that
  // is closed, or never opened, leaves the run exactly as it would have been.
  const traceWait = useFirstTraceWait(phase.kind === "approved", workspaces, traceUser);

  // Advancing on our own is the whole point: the person was told to go back to
  // their terminal, so nobody is here to click anything when the trace lands.
  useEffect(() => {
    if (traceWait.kind === "found") {
      router.push(traceUrl(traceWait.found));
    }
  }, [traceWait, router]);

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
      // Not signed in yet: go to sign-in, carrying the code (+ client_id) back
      // so the return lands on consent rather than the entry form.
      router.push(deviceSignInUrl(activeCode, clientId));
      return;
    }

    // Signed in, but the terminal must not be released to an account the CLI
    // cannot use: its next move is to resolve a workspace and a project, and it
    // has neither a way nor a remit to create them. Onboarding comes first and
    // hands the browser back here.
    //
    // Listing workspaces does not claim the code, so this is safe to do before
    // consent — unlike verifying, below.
    let cancelled = false;
    void (async () => {
      let workspaces: Awaited<ReturnType<typeof getWorkspaces>>;
      try {
        workspaces = await getWorkspaces();
      } catch {
        // Its own message rather than the device-error mapper: nothing is wrong
        // with the code, and naming it would send the user back to the CLI for
        // a fresh one that would fail here in exactly the same way.
        if (!cancelled) {
          setPhase({
            kind: "error",
            message:
              "Could not load this account's workspaces, so nothing was approved. Check your connection and reload this page.",
            recoverable: true,
          });
        }
        return;
      }
      if (cancelled) {
        return;
      }
      setWorkspaces(workspaces);
      const need = resolveSetupNeed(workspaces);
      if (need) {
        // Shown rather than redirected to: a device request nobody started must
        // stay refusable, and an auto-redirect takes Deny away from the one
        // person who should be able to use it. The screen gates approval and
        // keeps denial — and switching account — in reach.
        setPhase({ kind: "setup", need });
        return;
      }
      // Consent WITHOUT verifying yet. Verifying would claim the code for this
      // session (see claimActiveCode), binding it to whoever is already logged
      // in and defeating "Not you? Sign out". The claim happens when the user
      // approves or denies, so a stale/expired/already-used code surfaces then
      // rather than on load.
      setPhase({ kind: "consent" });
    })();

    return () => {
      cancelled = true;
    };
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
    // Approval is the last thing the browser *does*. Whatever the account still
    // needed — creating a workspace and a project on a brand-new one — happened
    // before this point, because releasing the terminal first would hand the CLI
    // an account that owns nothing to send traces to.
    //
    // It is not the last thing the browser *shows*, though: the approved panel
    // watches for the trace this run is about to produce. Navigating now would
    // be wrong — the project may not exist yet, nothing is instrumented, and no
    // trace has been sent, so every destination is an empty state that reads as
    // a failure. The panel waits where it is instead.
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
    router.push(deviceSignInUrl(code, clientId));
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

          {phase.kind === "setup" && activeCode && (
            <SetupRequired
              clientName={resolveClientDisplayName(clientId)}
              email={sessionData?.user?.email ?? null}
              code={activeCode}
              needsWorkspace={phase.need.kind === "workspace"}
              pending={actionPending}
              onContinue={() => router.push(deviceOnboardingUrl(phase.need, activeCode, clientId))}
              onDeny={handleDeny}
              onSwitchAccount={handleSwitchAccount}
            />
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

          {phase.kind === "approved" && <Approved wait={traceWait} />}

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

function CodeConfirm({ code }: { code: string }) {
  return (
    <div className="border bg-muted/50 px-3 py-2 text-center">
      <p className="text-[11px] uppercase text-muted-foreground">Confirm this code</p>
      <p className="text-[18px] font-semibold tracking-widest">{formatUserCode(code)}</p>
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
        <AccountLine email={email} pending={pending} onSwitchAccount={onSwitchAccount} />
      </div>

      <CodeConfirm code={code} />

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

type SetupRequiredProps = {
  clientName: string;
  email: string | null;
  code: string;
  needsWorkspace: boolean;
  pending: boolean;
  onContinue: () => void;
  onDeny: () => void;
  onSwitchAccount: () => void;
};

// Signed in, with nowhere for the CLI to send traces. Approval is the one thing
// this screen withholds: the request is still refusable, and the account is
// still switchable, because an unsolicited device request that can only be
// waited out is worse for the person looking at it than one extra click is for
// the person who really is setting up a terminal.
function SetupRequired({
  clientName,
  email,
  code,
  needsWorkspace,
  pending,
  onContinue,
  onDeny,
  onSwitchAccount,
}: SetupRequiredProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-1 text-center">
        <p className="text-[13px]">
          <span className="font-medium">{clientName}</span> wants to sign in
        </p>
        <AccountLine email={email} pending={pending} onSwitchAccount={onSwitchAccount} />
      </div>

      <CodeConfirm code={code} />

      <p className="text-[12px] text-muted-foreground">
        {needsWorkspace
          ? "This account has no workspace yet, so there is nowhere for traces to go."
          : "This account has no project yet, so there is nowhere for traces to go."}{" "}
        Finish setting up first — {clientName} asks for a project the moment it is signed in, and
        the terminal is waiting on this page.
      </p>

      <p className="border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
        Only continue for a code you generated yourself just now. If you didn&apos;t start a
        traceroot login, deny this.
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
        <Button
          size="sm"
          className="h-8 flex-1 text-[13px]"
          onClick={onContinue}
          disabled={pending}
        >
          Continue setup
        </Button>
      </div>
    </div>
  );
}

// Approved, and now watching for what the run does next.
//
// "Return to your terminal" stays on screen in every state of the wait, and
// stays first. It is still the correct instruction — the terminal is where the
// setup continues and where the outcome is reported — and this panel is only
// ever a shortcut to the trace, so a wait that ends badly, or never starts
// because the polling could not read anything, leaves the person exactly where
// they were before: approved, and pointed at their terminal.
function Approved({ wait }: { wait: TraceWait }) {
  return (
    <div className="space-y-3 py-4 text-center">
      <div>
        <p className="text-[14px] font-medium">Approved</p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Return to your terminal to finish setting up.
        </p>
      </div>

      {/* The same line the onboarding hand-back shows, from the same component:
          both pages wait for the same thing and open it the same way, and two
          copies of those lines had already drifted apart. Two things stay this
          page's own and are passed in: the waiting line's "opens it", the
          wording this page has always used, and the empty ending, because
          only this flow has a terminal holding the result either way. */}
      <FirstTraceLine
        wait={wait}
        arrival="This page opens it when it arrives."
        gaveUp={(ended) => (
          <div className="space-y-1 text-[11px] text-muted-foreground">
            <p>No trace has arrived yet. Your terminal has the result either way.</p>
            <p>
              <Link href={ended.fallbackUrl} className="underline hover:text-foreground">
                Open your traces
              </Link>
            </p>
          </div>
        )}
      />
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
