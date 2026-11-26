import type { Workspace } from "@/types/api";

/**
 * What an account still has to set up before it can be used.
 *
 * One predicate, because two pages ask the question and they must not disagree:
 * /device decides whether to release a waiting terminal, and /onboarding decides
 * whether there is anything left for its form to do. When /device sent a
 * read-only account to onboarding and onboarding counted the same workspace as
 * finished, "Continue setup" landed the user straight back on /device — a loop
 * with no form in it.
 */
export type SetupNeed =
  | { kind: "workspace" }
  | { kind: "project"; workspaceId: string; workspaceName: string };

// Creating a project needs MEMBER or higher — see the POST handler in
// app/api/workspaces/[workspaceId]/projects/route.ts — so a VIEWER's empty
// workspace is not somewhere either page can put one.
const PROJECT_CREATE_ROLES: ReadonlySet<Workspace["role"]> = new Set(["ADMIN", "MEMBER"]);

/**
 * What setup this account still needs, or `null` when it needs none.
 *
 * The bar is a *project*, not a workspace: the CLI resolves a workspace and then
 * a project, and traces are written to the latter. An empty workspace is not
 * hypothetical — it is the state of an account whose last project was deleted,
 * and of one whose workspace was created without finishing onboarding.
 *
 * `{ kind: "project" }` names a workspace this account may add to, so the caller
 * can ask for the one missing thing instead of offering a second workspace.
 * `{ kind: "workspace" }` is the answer when there is nothing to add to — no
 * workspaces at all, or only ones this account cannot create projects in.
 *
 * The public demo workspace (`is_demo`) is never one of the account's own, so it
 * counts for neither question.
 */
export function resolveSetupNeed(workspaces: Workspace[]): SetupNeed | null {
  // Every account joins the demo workspace as a VIEWER when it signs up, and the
  // demo has a project. Counted, it would mark a brand-new account as set up:
  // /onboarding would send it away before it has a workspace, and /device would
  // release the terminal to an account with no project of its own. Our team are
  // ADMINs of the demo, and it is not where their own project goes either.
  const own = workspaces.filter((workspace) => !workspace.is_demo);
  // `project_count` is optional on the type, so a payload without it reads as
  // empty. That is the deliberate direction: a needless trip through onboarding
  // costs a click, whereas treating an account with no project as ready is the
  // dead end this check exists to prevent.
  if (own.some((workspace) => (workspace.project_count ?? 0) > 0)) {
    return null;
  }
  const addable = own.find((workspace) => PROJECT_CREATE_ROLES.has(workspace.role));
  if (!addable) {
    return { kind: "workspace" };
  }
  return { kind: "project", workspaceId: addable.id, workspaceName: addable.name };
}

/**
 * The onboarding URL that answers a `SetupNeed`, optionally carrying a caller to
 * hand back to once the form is done.
 *
 * `?workspaceId=` is what puts onboarding in project-only mode, so a need of
 * `project` lands on the project form with the workspace already settled.
 */
export function onboardingUrlForSetup(need: SetupNeed, callbackUrl: string | null): string {
  const handBack = callbackUrl === null ? null : `callbackUrl=${encodeURIComponent(callbackUrl)}`;
  if (need.kind === "workspace") {
    return handBack === null ? "/onboarding" : `/onboarding?${handBack}`;
  }
  const workspace =
    `workspaceId=${encodeURIComponent(need.workspaceId)}` +
    `&workspaceName=${encodeURIComponent(need.workspaceName)}`;
  return handBack === null ? `/onboarding?${workspace}` : `/onboarding?${workspace}&${handBack}`;
}
