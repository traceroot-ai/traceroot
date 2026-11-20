"use client";

import { Suspense, useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Logo } from "@/components/Logo";
import { AccountLine } from "@/components/account-line";
import { createWorkspace, createProject, getProjects, getWorkspaces } from "@/lib/api";
import { ApiError } from "@/lib/api/errors";
import type { Project, Workspace } from "@/types/api";
import { safeCallbackUrl } from "@/lib/safe-callback-url";
import { resolveSetupNeed, onboardingUrlForSetup } from "@/lib/account-setup";
import { StandaloneFrame } from "@/features/onboarding/components/standalone-frame";
import { questionsStepUrl } from "@/features/onboarding/step-urls";
import { isPersonalEmail } from "@/lib/personal-email";

/** The first project's name. Renamed, like the workspace, in settings. */
const DEFAULT_PROJECT_NAME = "my-llm-project";

function getDefaultWorkspaceName(email: string | null | undefined): string {
  if (!email) return "My Workspace";

  const domain = email.split("@")[1];
  if (!domain) return "My Workspace";

  if (isPersonalEmail(email)) return "My Workspace";

  const company = domain.split(".")[0];
  return company.charAt(0).toUpperCase() + company.slice(1);
}

// This page's own URL, for a round trip that has to come back to it. Whatever a
// waiting `traceroot setup` terminal is polling against travels on it, because
// a sign-in that drops `callbackUrl` strands that terminal for the whole
// device-code lifetime with nothing left pointing back at the handoff.
//
// `?workspaceId=` is deliberately not carried. It names a workspace owned by
// the account being signed *out* of, and the point of the round trip is to come
// back as someone else — who cannot add a project to it. An account that signs
// back in as itself gets the parameter re-derived from the setup check below, so
// nothing is lost either way.
function onboardingReturnUrl(returnTo: string | null): string {
  return returnTo === null
    ? "/onboarding"
    : `/onboarding?callbackUrl=${encodeURIComponent(returnTo)}`;
}

// Sign-in, returning here afterwards. better-auth stores the whole callbackUrl
// — query included — in the OAuth state and redirects to it verbatim, so the
// hand-back survives the Google hop and not just an email sign-in. Shared by
// the signed-out redirect and "Not you? Sign out" so the two cannot drift,
// which is how /device says the same thing (see deviceSignInUrl there).
function onboardingSignInUrl(returnTo: string | null): string {
  return `/auth/sign-in?callbackUrl=${encodeURIComponent(onboardingReturnUrl(returnTo))}`;
}

// The workspace a 409 collided with, when the list names it unambiguously.
//
// `createdBy` — the other half of `uq_workspace_created_by_name` — is not in
// the list payload, so "is this one mine?" is answered by role instead: the
// POST handler makes the creator an ADMIN member, so a workspace this account
// created always reads ADMIN, and a MEMBER or VIEWER row under the same name is
// somebody else's. Two ADMIN rows can still share a name — this account being
// promoted in someone else's — and adopting the wrong one would put the user's
// first project in a workspace that is not theirs, so an ambiguous answer is no
// answer and the collision stands.
function findOwnWorkspaceByName(workspaces: Workspace[], name: string): Workspace | null {
  const mine = workspaces.filter(
    (workspace) => workspace.name === name && workspace.role === "ADMIN",
  );
  return mine.length === 1 ? mine[0] : null;
}

// The workspace this attempt should use: a new one, or the one an earlier
// attempt created and could not report back.
//
// A create that throws has not necessarily failed. The POST can commit and the
// response still be lost — a dropped connection, a proxy answering 502 after
// the write, a 5xx raised after the transaction — and the workspace then exists
// while this page holds no id for it. `createdWorkspace` is assigned from the
// response, so it stays null through exactly that case, and the retry submits
// the same name again. That collides with `uq_workspace_created_by_name`, the
// route answers 409, and the user is stopped on the first screen of their
// account by a workspace they do not know they own — with no way past it, since
// pressing Create is the whole recovery path this page offers.
//
// The status alone identifies the collision. This endpoint's only 409 is that
// constraint (see app/api/workspaces/route.ts; everything else it refuses is a
// 400 or a 401), and matching the message would tie recovery to prose written
// to be read by a person. The lookup is guarded regardless, so a 409 that came
// to mean something else could not adopt anything.
//
// What this does not recover is an edited name after a lost response: with no
// id in hand, a retry under a different name cannot collide, so it creates a
// second workspace and leaves the first orphaned. Finding that one would mean
// matching an empty workspace by something other than the name that was
// submitted — and an empty workspace is also what one somebody made deliberately
// and has not filled yet looks like.
async function createOrAdoptWorkspace(name: string): Promise<{ id: string; name: string }> {
  try {
    const workspace = await createWorkspace(name);
    return { id: workspace.id, name };
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) {
      throw err;
    }
    // Read through the API rather than the page's query: the cached list is
    // whatever it held when creating started — `[]` for a first-run account —
    // and nothing has invalidated it, because the only invalidation here follows
    // a project that was never created.
    const adopted = findOwnWorkspaceByName(await getWorkspaces(), name);
    if (!adopted) {
      throw err;
    }
    return { id: adopted.id, name };
  }
}

// The project a 409 collided with, when the workspace's own list names it.
//
// Which row the create collided with is all this answers, unlike the workspace
// lookup above: whether that row is this attempt's to adopt is settled by the
// caller, before the lookup is reached at all (see `createOrAdoptProject`).
// `uq_project_workspace_live_name` is scoped to one workspace, the caller is
// already a member of that workspace (the route refuses anyone else with a
// 403), and the listing leaves out soft-deleted rows — which the index also
// ignores. So a live row under this name is the row the create collided with,
// and the index permits exactly one of them. More than one would mean the index
// is not there, which is not something to adopt a project on.
function findLiveProjectByName(projects: Project[], name: string): Project | null {
  const live = projects.filter((project) => project.name === name && !project.delete_time);
  return live.length === 1 ? live[0] : null;
}

// The project this attempt should use: a new one, or the one an earlier attempt
// created and could not report back. `adoptable` says whether a 409 may be
// adopted at all: false when the workspace predates this page, where a project
// under the same name may be a teammate's, so the 409 is reported instead.
async function createOrAdoptProject(
  workspaceId: string,
  name: string,
  adoptable: boolean,
): Promise<{ id: string; name: string }> {
  try {
    const project = await createProject(workspaceId, name);
    return { id: project.id, name: project.name };
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) {
      throw err;
    }
    if (!adoptable) {
      throw err;
    }
    const adopted = findLiveProjectByName(await getProjects(workspaceId), name);
    if (!adopted) {
      throw err;
    }
    return { id: adopted.id, name: adopted.name };
  }
}

function OnboardingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { data: session, isPending } = authClient.useSession();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSwitchingAccount, setIsSwitchingAccount] = useState(false);
  const [createdProject, setCreatedProject] = useState<{ id: string; name: string } | null>(null);
  // The workspace outlives a failed project step, and the retry is the button
  // right under the error. Creating it again would collide with
  // `uq_workspace_created_by_name` (a 409), walling the user off the first
  // screen with no way forward.
  //
  // This only ever holds a workspace whose create *answered*. An attempt that
  // committed and lost its response leaves it null, which is what
  // `createOrAdoptWorkspace` is for.
  const createdWorkspace = useRef<{ id: string; name: string } | null>(null);
  // Creating starts by itself, once: the workspace and project are made with
  // default names as soon as the account is known to need them. After that only
  // Try again starts it.
  const started = useRef(false);

  // Determine mode from query params
  const existingWorkspaceId = searchParams.get("workspaceId");
  const isProjectOnlyMode = !!existingWorkspaceId;

  // Where to go once the project exists. A caller that handed us somewhere to
  // return to is mid-flow somewhere else — today only `traceroot setup`, which
  // is holding a terminal open waiting on the device approval this page now
  // runs ahead of. Attacker-suppliable, so same-origin only.
  const callbackUrl = searchParams.get("callbackUrl");
  // `safeCallbackUrl` answers a rejected value with its fallback, so an empty
  // fallback plus `|| null` is how "there is nowhere to go back to" is said —
  // otherwise a crafted link sends a new user to `/` instead of their traces.
  const returnTo = callbackUrl === null ? null : safeCallbackUrl(callbackUrl, "") || null;

  // An account that already has somewhere for traces to go has nothing to do on
  // this page, and arriving here anyway is not hypothetical. No caller can tell a
  // brand-new account from an existing one at the point it decides where to send
  // someone: better-auth has no separate social sign-up, so each social button on
  // /auth/sign-up is `signIn.social` either way, and with account linking
  // enabled for Google only (see lib/auth.ts) Google also answers for an existing
  // *email* account at the same address. Predicting newness there has been wrong twice.
  // So the page checks the account instead of trusting the route it took.
  //
  // Without this, an existing account that lands here would get a second
  // workspace and project, and when a terminal is
  // waiting on `returnTo` that duplicate is the only way back to it. An account
  // that is *part* way there — a workspace with no project in it — is why the
  // check resolves three answers rather than a boolean.
  //
  // Project-only mode is the exception. `?workspaceId=` means "add a project to
  // this workspace I already own", so owning one is the precondition rather than
  // a reason to leave — and the query stays off, because react-query would still
  // hand back a cached list for this key with it disabled.
  //
  // The key carries the account id, because the decision below is only sound if
  // the list belongs to the account making it. One QueryClient lives as long as
  // the tab (see app/providers.tsx) and survives a sign-out that stays inside
  // the app — /device's "Not you? Sign out" is exactly that — so a bare
  // "workspaces" entry would let the previous account's list answer here and
  // mark a brand-new account onboarded before its own request even finished.
  // Writers elsewhere still reach this entry: react-query matches query keys by
  // prefix, so `invalidateQueries({ queryKey: ["workspaces"] })` covers every
  // per-account key under it.
  const userId = session?.user?.id;
  const { data: workspaces, isLoading: workspacesLoading } = useQuery({
    queryKey: ["workspaces", userId],
    queryFn: getWorkspaces,
    enabled: !!userId && !isProjectOnlyMode,
  });
  // What this account still needs, by the one predicate /device gates the
  // terminal on (lib/account-setup). Asking the same question both places is the
  // point: a *workspace* is not the bar, a project is, and when the two pages
  // disagreed about that a read-only account bounced between them forever —
  // /device sent it here because it cannot add a project to the workspace it
  // belongs to, and here counted that same workspace as finished.
  //
  // `undefined` means there is no answer to act on yet: the list is still in
  // flight, the lookup failed, this is project-only mode, or this page has
  // already done the work.
  //
  // `userId` is part of that guard and not just the query's gate: a signed-out
  // visitor belongs in the sign-in branch below, which is the one that keeps a
  // waiting terminal's `callbackUrl` alive across the round trip. And
  // `createdProject` is in it because this page creates the very project the
  // check looks for — the invalidation in `handleSubmit` refetches the list,
  // which now has one, and without this a first-run account would be bounced off
  // the hand-back step, away from the command it was about to copy.
  const setupNeed =
    !!userId && !isProjectOnlyMode && !createdProject && workspaces
      ? resolveSetupNeed(workspaces)
      : undefined;
  const setupComplete = setupNeed === null;
  // An empty workspace this account may add to. Adding the project alone is the
  // honest answer — the workspace exists, so offering a second one is not — and
  // `?workspaceId=` is exactly where /device sends this case, so an account that
  // walks in here directly ends up on the same screen. A URL rather than the
  // need itself, because `resolveSetupNeed` returns a fresh object every render
  // and an unstable dependency would re-push on each one.
  const addProjectUrl =
    setupNeed?.kind === "project" ? onboardingUrlForSetup(setupNeed, returnTo) : null;

  useEffect(() => {
    if (setupComplete) {
      // Hand back to whatever is waiting, exactly as a finished run would — a
      // terminal blocked on the device approval cannot tell the two apart, and
      // it only ever needed a project to exist. With nobody waiting, the
      // workspace list is where a set-up account belongs.
      router.push(returnTo ?? "/workspaces");
      return;
    }
    if (addProjectUrl) {
      router.push(addProjectUrl);
    }
  }, [setupComplete, addProjectUrl, returnTo, router]);

  const defaultWorkspace = getDefaultWorkspaceName(session?.user?.email);

  // Ready to create once the session is known and the setup check has settled
  // on "this account needs a workspace" (or a failed check fell through — see
  // the render guard below), or this is project-only mode.
  const readyToCreate =
    !!session && !isPending && !workspacesLoading && !setupComplete && !addProjectUrl;
  useEffect(() => {
    if (!readyToCreate || started.current) return;
    started.current = true;
    void handleSubmit();
    // handleSubmit reads this render's values; `started` makes this run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyToCreate]);

  async function handleSubmit() {
    setIsLoading(true);
    setError(null);

    try {
      let workspaceId = existingWorkspaceId;

      // Create workspace if not in project-only mode
      if (!isProjectOnlyMode) {
        const workspace =
          createdWorkspace.current ?? (await createOrAdoptWorkspace(defaultWorkspace));
        createdWorkspace.current = workspace;
        workspaceId = workspace.id;
      }

      if (!workspaceId) {
        setError("Workspace not found");
        setIsLoading(false);
        return;
      }

      // Adoptable only where this attempt is what put the workspace here: in
      // project-only mode the workspace predates this page and can be shared.
      const project = await createOrAdoptProject(
        workspaceId,
        DEFAULT_PROJECT_NAME,
        !isProjectOnlyMode,
      );

      queryClient.invalidateQueries({ queryKey: ["workspaces"] });

      // Kept so the setup check below does not count this account as finished
      // and move it to /workspaces while the next step loads.
      setCreatedProject({ id: project.id, name: project.name });
      // On to the questions, which have their own address with the project in
      // it, so a refresh from here on creates nothing again. A waiting
      // `traceroot setup` terminal's hand-back travels with them: it gets its
      // terminal back after the questions, without the connect and setup steps,
      // which are about a run that is already underway.
      router.replace(
        questionsStepUrl(project.id, isProjectOnlyMode ? "project" : "workspace", returnTo),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setIsLoading(false);
    }
  }

  // Signed in as the wrong account, which has no other way out of this page: the
  // shell's user menu was the only one and this page no longer renders it (see
  // lib/chromeless-routes). Navigating away to find a sign-out drops the
  // `callbackUrl` with it, which is the stranding that removing the shell was
  // meant to prevent — so the way out has to be here, and it has to come back.
  //
  // Whether a sign-out is worth offering at all is not a judgement this page
  // gets to make: better-auth has no separate social sign-up, so the Google
  // button on sign-in and sign-up alike answers for any address already linked
  // to that identity, and landing here as the wrong account is a routine
  // outcome rather than a mistake the user can be assumed out of.
  async function handleSwitchAccount() {
    setIsSwitchingAccount(true);
    setError(null);
    let cleared: boolean;
    try {
      // The client answers an HTTP failure in `error` and rejects only when the
      // request never completed, so both have to be read before the session can
      // be called cleared. A rate limit or a proxy error leaves the cookie in
      // place, and leaving on it sends the user to a sign-in that the live
      // session hands straight back to this page as the same account — the
      // stranding this button exists to undo, now with nothing said about it.
      const { error: signOutError } = await authClient.signOut();
      cleared = !signOutError;
    } catch {
      cleared = false;
    }
    if (!cleared) {
      // Both halves matter: a page that cannot be used by this account, behind a
      // button that stays disabled, says nothing at all about what went wrong.
      setError("Could not sign out. Please try again.");
      setIsSwitchingAccount(false);
      return;
    }
    // Pushed here rather than left to the signed-out branch below, which does
    // reach the same URL once the cleared session re-renders: which of the two
    // happens first is not something the destination should depend on.
    router.push(onboardingSignInUrl(returnTo));
  }

  // Creating waits until the setup question is settled, not just until the
  // session is: starting early would create the duplicate workspace the check
  // above exists to prevent — which is also why a pending redirect into
  // project-only mode holds it (see `readyToCreate`). A failed check leaves
  // `workspaces` undefined and falls through to creating on purpose: a duplicate
  // workspace is recoverable, whereas a brand-new account that cannot reach this
  // page at all has no way to finish signing up.
  if (isPending || workspacesLoading || setupComplete || addProjectUrl) {
    return (
      <StandaloneFrame>
        <p className="text-[13px] text-muted-foreground">Loading...</p>
      </StandaloneFrame>
    );
  }

  if (!session && !isPending) {
    // Carry the hand-back on through sign-in. A null session here is not only
    // "never signed in" — it is also a cookie not yet visible after a social
    // hop, an expiry mid-way, or the sign-out "Not you?" just performed — and
    // dropping `callbackUrl` at this point strands a terminal that is still
    // polling, for the full device-code lifetime, with no way back to it.
    router.push(onboardingSignInUrl(returnTo));
    return (
      <StandaloneFrame>
        <p className="text-[13px] text-muted-foreground">Redirecting to sign in...</p>
      </StandaloneFrame>
    );
  }

  return (
    <StandaloneFrame>
      <div className="w-full max-w-md">
        {/* Header. The logo is here because the sidebar carried the only one on
            this page, and the shell it belonged to is gone — /auth and /device
            front their cards the same way, which is the run of screens this
            page sits in the middle of.
            Everything that is the same on every step lives in this block, which
            is the block `StandaloneFrame` pins to the top of the viewport. */}
        <div className="mb-4 flex flex-col items-center gap-2 text-center">
          <Logo size="lg" />
          <div>
            {/* The first run, named as one. "Setup" is the word this product
                already uses for two other things — the `traceroot setup`
                command this page hands over to, and the settings screens a
                returning account goes to — and a heading that reads like a
                settings tab is the wrong frame for the only page an account
                sees once. "Get started" is also what the traces panel calls
                this same content, so the two surfaces now agree. The line
                under it is what says which of the two routes you are on, and
                it carries more now that the step below says what the command
                does. */}
            <h1 className="text-[15px] font-medium">Let&apos;s get started</h1>
            <p className="text-[13px] text-muted-foreground">
              Setting up your workspace and first project
            </p>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-4 border border-danger-border bg-danger-soft p-3 text-[12px] text-danger">
            {error}
          </div>
        )}

        <Card>
          <CardContent className="p-4">
            {error ? (
              <div className="flex items-center justify-center gap-2">
                <Button
                  size="sm"
                  className="h-7 px-4 text-[12px]"
                  onClick={handleSubmit}
                  disabled={isLoading}
                >
                  Try again
                </Button>
                {/* Back to whatever is waiting, when something is. The
                      workspace list drops `returnTo`, and for a terminal on
                      /device that strands it until the code expires; /device
                      itself still offers Deny. */}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-4 text-[12px]"
                  onClick={() => router.push(returnTo ?? "/workspaces")}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <p className="py-2 text-center text-[12px] text-muted-foreground">
                {isProjectOnlyMode
                  ? "Creating your first project…"
                  : "Creating your workspace and first project…"}
              </p>
            )}

            {/* Which account this is, and the way out of it. Here only: once
                  the project exists this account is the one the rest of the
                  flow is about, and the app — with its user menu — is a click
                  away. Disabled while a create is in flight, so a sign-out
                  cannot land between the workspace and the project. */}
            <div className="mt-4">
              <AccountLine
                email={session?.user?.email ?? null}
                pending={isLoading || isSwitchingAccount}
                onSwitchAccount={handleSwitchAccount}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </StandaloneFrame>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense>
      <OnboardingContent />
    </Suspense>
  );
}
