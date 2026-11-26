/**
 * The sign-up steps after the project exists, each with its own address that
 * carries the project. The project used to live only in the onboarding page's
 * state, which a trip to GitHub or Slack to authorize, or a refresh, loses; and
 * back on /onboarding with a project, the page counts setup as done and moves on.
 *
 * `created` says what this run made, for the steps' wording: a workspace and its
 * project, or only a project in a workspace the account already had.
 */
export type CreatedInRun = "workspace" | "project";

function stepUrl(step: string, projectId: string, created: CreatedInRun): string {
  const query = new URLSearchParams({ projectId });
  if (created === "project") query.set("created", "project");
  return `/onboarding/${step}?${query}`;
}

export const connectStepUrl = (projectId: string, created: CreatedInRun) =>
  stepUrl("connect", projectId, created);

export const setupStepUrl = (projectId: string, created: CreatedInRun) =>
  stepUrl("setup", projectId, created);

/**
 * The questions step, the first after the project exists. `returnTo` is a
 * waiting terminal's hand-back (`callbackUrl`), carried so the questions can
 * return it there instead of going on to the connect step.
 */
export function questionsStepUrl(
  projectId: string,
  created: CreatedInRun,
  returnTo: string | null,
): string {
  const query = new URLSearchParams({ projectId });
  if (created === "project") query.set("created", "project");
  if (returnTo !== null) query.set("callbackUrl", returnTo);
  return `/onboarding/questions?${query}`;
}

/** What the run made, as the step's address says. */
export function createdInRun(searchParams: URLSearchParams): CreatedInRun {
  return searchParams.get("created") === "project" ? "project" : "workspace";
}
