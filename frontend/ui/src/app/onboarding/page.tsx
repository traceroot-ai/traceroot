"use client";

import { Suspense, useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod/v3";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Logo } from "@/components/Logo";
import { AccountLine } from "@/components/account-line";
import {
  createWorkspace,
  updateWorkspace,
  createProject,
  getProjects,
  getWorkspaces,
} from "@/lib/api";
import { ApiError } from "@/lib/api/errors";
import type { Project, Workspace } from "@/types/api";
import { safeCallbackUrl } from "@/lib/safe-callback-url";
import { resolveSetupNeed, onboardingUrlForSetup } from "@/lib/account-setup";
import { Check } from "lucide-react";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { CliHandbackStep } from "@/features/onboarding/components/cli-handback-step";
import { ManualSetupStep } from "@/features/onboarding/components/manual-setup-step";
import { cn } from "@/lib/utils";

const onboardingSchema = z.object({
  workspaceName: z.string().min(1, "Workspace name is required"),
  projectName: z.string().min(1, "Project name is required"),
});

type OnboardingForm = z.infer<typeof onboardingSchema>;

function getDefaultWorkspaceName(email: string | null | undefined): string {
  if (!email) return "My Workspace";

  const domain = email.split("@")[1];
  if (!domain) return "My Workspace";

  const freeProviders = [
    "gmail.com",
    "yahoo.com",
    "hotmail.com",
    "outlook.com",
    "icloud.com",
    "protonmail.com",
    "mail.com",
  ];
  if (freeProviders.includes(domain.toLowerCase())) {
    return "My Workspace";
  }

  const company = domain.split(".")[0];
  return company.charAt(0).toUpperCase() + company.slice(1);
}

// The frame the app shell used to provide. This page renders outside the shell
// (see lib/chromeless-routes), so it is also outside the `<main>` that gave the
// old `h-full` something to resolve against — nothing sets a height on html or
// body, so a percentage height here collapses to the content. `min-h-screen` is
// what makes the empty background actually fill the screen, and `min-h-` rather
// than `h-` is what lets the box grow past the viewport once the step after the
// form is taller than it, instead of clipping the top of the card.
function StandaloneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4">
      {children}
    </div>
  );
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
    // whatever it held when the form was shown — `[]` for a first-run account —
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
// There is no ownership to establish here, unlike the workspace lookup above.
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
// created and could not report back.
//
// The same lost response as the workspace above, one step later. `createdProject`
// is set from the response, so a POST that commits without answering leaves it
// null and the retry submits the same name into the same workspace — by then the
// adopted or remembered one, so the collision is with the project the first
// attempt wrote. The route answers 409 and that is the end of the account: this
// is the last screen of sign-up and pressing Create is all it offers.
//
// The status identifies the collision on its own, as it does for the workspace:
// this endpoint's only 409 is that constraint (see
// app/api/workspaces/[workspaceId]/projects/route.ts, which maps Prisma's P2002
// to it; everything else it refuses is a 400 or a 403). The lookup is guarded
// regardless, so a 409 that came to mean something else could not adopt
// anything.
//
// In project-only mode the workspace can be a shared one, where the 409 can
// instead be a teammate's project under the same name. Adopting it is still the
// better of the two answers: the user is a member of that workspace, the project
// is the one they asked for by name, and the alternative is a first run that
// cannot be finished. What this does not recover is an edited name after a lost
// response — with no id in hand a retry under a different name cannot collide,
// so it creates a second project and leaves the first unmentioned.
async function createOrAdoptProject(
  workspaceId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  try {
    const project = await createProject(workspaceId, name);
    return { id: project.id, name: project.name };
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) {
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
  // The workspace outlives a failed project step, and the retry is the same
  // button right under the error. Creating it again is worse than untidy. With
  // the name unchanged it collides with `uq_workspace_created_by_name` and the
  // route turns that into a 409 ("A workspace with this name already exists"),
  // so the retry cannot succeed at all and the user is walled off the first
  // screen with no way forward. With the name edited it does succeed, and
  // leaves the first workspace behind, orphaned and not mentioned anywhere.
  //
  // The name travels with the id, because reusing the workspace must not mean
  // ignoring the field: a user who renames it before retrying has said what
  // they want it called, and the other two readings — create a second one under
  // the new name, or keep the old name silently — are both wrong. Recording the
  // new name here is also what stops a third attempt renaming it again.
  //
  // This only ever holds a workspace whose create *answered*. An attempt that
  // committed and lost its response leaves it null, which is what
  // `createOrAdoptWorkspace` is for.
  const createdWorkspace = useRef<{ id: string; name: string } | null>(null);
  // Which of the two post-creation steps is showing. Separate from
  // `createdProject` rather than folded into one enum because that value is
  // also what tells the rest of the page this account is no longer a candidate
  // for the setup check below, and that has to stay true across both steps.
  //
  // "Set up manually" used to leave for the project's traces page, where this
  // same walkthrough lives. It worked, and it surprised people: signing up had
  // visibly ended somewhere in the middle, with no marker for where the flow
  // stopped and the app began. So the walkthrough is shown here instead, in
  // the frame the previous two steps used, and the user leaves when they say
  // so.
  const [manualSetup, setManualSetup] = useState(false);

  // Determine mode from query params
  const existingWorkspaceId = searchParams.get("workspaceId");
  const existingWorkspaceName = searchParams.get("workspaceName");
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
  // someone: better-auth has no separate social sign-up, so the Google button on
  // /auth/sign-up is `signIn.social` either way, and with account linking
  // enabled for Google (see lib/auth.ts) it also answers for an existing *email*
  // account at the same address. Predicting newness there has been wrong twice.
  // So the page checks the account instead of trusting the route it took.
  //
  // Without this, an existing account that lands here is parked: the form's only
  // exit is creating a second workspace and project, and when a terminal is
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
  // flight, the lookup failed, this is project-only mode, or the form on this
  // page has already done the work.
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
  // An empty workspace this account may add to. The project form is the honest
  // answer — the workspace exists, so offering a second one is not — and
  // `?workspaceId=` is exactly where /device sends this case, so an account that
  // walks in here directly ends up on the same screen. A URL rather than the
  // need itself, because `resolveSetupNeed` returns a fresh object every render
  // and an unstable dependency would re-push on each one.
  const addProjectUrl =
    setupNeed?.kind === "project" ? onboardingUrlForSetup(setupNeed, returnTo) : null;

  useEffect(() => {
    if (setupComplete) {
      // Hand back to whatever is waiting, exactly as a completed form would — a
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

  const {
    register,
    formState: { errors },
    getValues,
  } = useForm<OnboardingForm>({
    resolver: zodResolver(onboardingSchema),
    defaultValues: {
      workspaceName: defaultWorkspace,
      projectName: "my-llm-project",
    },
    values: {
      workspaceName: defaultWorkspace,
      projectName: "my-llm-project",
    },
  });

  async function handleSubmit() {
    setIsLoading(true);
    setError(null);

    try {
      let workspaceId = existingWorkspaceId;

      // Create workspace if not in project-only mode
      if (!isProjectOnlyMode) {
        const workspaceName = getValues("workspaceName");
        if (!workspaceName) {
          setError("Workspace name is required");
          setIsLoading(false);
          return;
        }
        const existing = createdWorkspace.current;
        if (existing) {
          if (existing.name !== workspaceName) {
            await updateWorkspace(existing.id, workspaceName);
          }
          createdWorkspace.current = { id: existing.id, name: workspaceName };
          workspaceId = existing.id;
        } else {
          const workspace = await createOrAdoptWorkspace(workspaceName);
          createdWorkspace.current = workspace;
          workspaceId = workspace.id;
        }
      }

      if (!workspaceId) {
        setError("Workspace not found");
        setIsLoading(false);
        return;
      }

      // Create project
      const projectName = getValues("projectName");
      if (!projectName) {
        setError("Project name is required");
        setIsLoading(false);
        return;
      }

      const project = await createOrAdoptProject(workspaceId, projectName);

      queryClient.invalidateQueries({ queryKey: ["workspaces"] });

      // A terminal that is already mid-`traceroot setup` does not need to be
      // told to run it. It is blocked on the device approval this page runs
      // ahead of, and everything the hand-back step would offer — the command,
      // the manual walkthrough, the way out — is a question about a run that is
      // already underway. So that step is for a browser-first user only, and a
      // waiting caller gets its terminal back the moment the project exists.
      if (returnTo !== null) {
        router.push(returnTo);
        return;
      }

      setCreatedProject({ id: project.id, name: project.name });
      setIsLoading(false);
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

  // The form is withheld until the setup question is settled, not just until the
  // session is: rendering it early lets a fast submit create the duplicate
  // workspace the check above exists to prevent — which is also why a pending
  // redirect into project-only mode withholds it. A failed check leaves
  // `workspaces` undefined and falls through to the form on purpose: a duplicate
  // workspace is recoverable, whereas a brand-new account that cannot reach this
  // form at all has no way to finish signing up.
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
    // hop, an expiry mid-form, or the sign-out "Not you?" just performed — and
    // dropping `callbackUrl` at this point strands a terminal that is still
    // polling, for the full device-code lifetime, with no way back to it.
    router.push(onboardingSignInUrl(returnTo));
    return (
      <StandaloneFrame>
        <p className="text-[13px] text-muted-foreground">Redirecting to sign in...</p>
      </StandaloneFrame>
    );
  }

  // What this run has already done, said once and reused by both of the steps
  // that follow the form.
  const createdWhat = isProjectOnlyMode ? "Project" : "Workspace and project";
  // One answer for the frame, the heading and the body, so a width can never
  // describe a step that is not the one rendered.
  const showManualStep = !!createdProject && manualSetup;

  return (
    <StandaloneFrame>
      {/* The walkthrough is five numbered steps with code in them, so its step
          gets a wider column than a two-field form needs. Same centred frame
          either way — the point of keeping it is that the flow still visibly
          has an end. */}
      <div className={cn("w-full", showManualStep ? "max-w-2xl" : "max-w-md")}>
        {/* Header. The logo is here because the sidebar carried the only one on
            this page, and the shell it belonged to is gone — /auth and /device
            front their cards the same way, which is the run of screens this
            page sits in the middle of. */}
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Logo size="lg" />
          <div>
            <h1 className="text-lg font-semibold">Setup</h1>
            <p className="text-[13px] text-muted-foreground">
              {/* "The rest happens in your terminal" stops being true the
                  moment the user says they would rather it did not. */}
              {showManualStep
                ? `${createdWhat} created — add tracing to your application`
                : createdProject
                  ? `${createdWhat} created — the rest happens in your terminal`
                  : "Set up your workspace and first project"}
            </p>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-4 border border-red-200 bg-red-50 p-3 text-[12px] text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Tree Form */}
        <Card>
          <CardContent className="p-4">
            {createdProject ? (
              manualSetup ? (
                <ManualSetupStep
                  projectId={createdProject.id}
                  onBack={() => setManualSetup(false)}
                  // The project's own traces page, which is where the first trace
                  // of the run they are about to instrument will land. It is also
                  // the one page that keeps this same walkthrough on screen until
                  // that trace arrives (see the traces page's getting-started
                  // branch), so leaving half-way through loses nothing — and
                  // unlike the workspace list, it has something to say to an
                  // account whose only project is empty.
                  onDone={() => router.push(`/projects/${createdProject.id}/traces`)}
                />
              ) : (
                <CliHandbackStep
                  projectId={createdProject.id}
                  projectName={createdProject.name}
                  // The instrumentation half of "manually", which is what exists
                  // today: the getting-started panel's manual walkthrough, shown
                  // as a step of this flow rather than navigated to. The provider
                  // half goes in front of that step, so this stays the one line
                  // that moves when it arrives.
                  onSetUpManually={() => setManualSetup(true)}
                  // Where an onboarded account with nobody waiting belongs, and
                  // the same place the already-onboarded check above sends one.
                  // Skipping leaves a workspace with a project in it, which is a
                  // finished account by every check the app makes — so nothing
                  // routes this user back here, and nothing shows them a project
                  // they cannot open.
                  onSkip={() => router.push("/workspaces")}
                />
              )
            ) : (
              <>
                <div className="space-y-0">
                  {/* Workspace Section */}
                  <div className="flex items-start gap-3">
                    <div className="flex flex-col items-center">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-primary/10">
                        {isProjectOnlyMode ? (
                          <Check className="h-4 w-4 text-primary" />
                        ) : (
                          <DOMAIN_ICONS.workspace className="h-4 w-4 text-primary" />
                        )}
                      </div>
                      {/* Vertical connector line */}
                      <div className="my-1.5 h-12 w-px bg-border" />
                    </div>
                    <div className="flex-1 pb-2 pt-0.5">
                      <label className="text-[13px] font-medium">Workspace</label>
                      <p className="mb-2 text-[11px] text-muted-foreground">
                        Your team's home for billing and members
                      </p>
                      {isProjectOnlyMode ? (
                        <div className="flex max-w-xs items-center gap-2 border bg-muted/50 px-2.5 py-1.5 text-[13px]">
                          <span>{existingWorkspaceName || "Selected workspace"}</span>
                          <Check className="ml-auto h-3.5 w-3.5 text-green-600" />
                        </div>
                      ) : (
                        <Input
                          placeholder="Acme Inc"
                          {...register("workspaceName")}
                          className="h-8 max-w-xs text-[13px]"
                        />
                      )}
                      {errors.workspaceName && (
                        <p className="mt-1 text-[11px] text-red-500">
                          {errors.workspaceName.message}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Project Section */}
                  <div className="flex items-start gap-3">
                    <div className="flex flex-col items-center">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted">
                        <DOMAIN_ICONS.project className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>
                    <div className="flex-1 pb-2 pt-0.5">
                      <label className="text-[13px] font-medium">Project</label>
                      <p className="mb-2 text-[11px] text-muted-foreground">
                        Where your traces and experiments live
                      </p>
                      <Input
                        placeholder="my-llm-project"
                        {...register("projectName")}
                        className="h-8 max-w-xs text-[13px]"
                      />
                      {errors.projectName && (
                        <p className="mt-1 text-[11px] text-red-500">
                          {errors.projectName.message}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="mt-6 flex items-center justify-center gap-2">
                  <Button
                    size="sm"
                    className="h-7 px-4 text-[12px]"
                    onClick={handleSubmit}
                    disabled={isLoading}
                  >
                    {isLoading ? "Creating..." : "Create"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-4 text-[12px]"
                    onClick={() => router.push("/workspaces")}
                  >
                    Cancel
                  </Button>
                </div>

                {/* Which account this is, and the way out of it. On the form
                    step only: once the project exists this account is the one
                    the rest of the flow is about, and the app — with its user
                    menu — is a click away. Disabled while a create is in
                    flight, so a sign-out cannot land between the workspace and
                    the project. */}
                <div className="mt-4">
                  <AccountLine
                    email={session?.user?.email ?? null}
                    pending={isLoading || isSwitchingAccount}
                    onSwitchAccount={handleSwitchAccount}
                  />
                </div>
              </>
            )}
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
