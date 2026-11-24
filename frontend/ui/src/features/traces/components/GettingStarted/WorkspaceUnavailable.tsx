/**
 * Stands in for a workspace-scoped step when there is no workspace to scope it
 * to.
 *
 * An errored project fetch is not a loading state: react-query drops
 * `isLoading` with no data behind it, so rendering a step on `!isLoading` alone
 * hands it an empty workspace id. That is worse than nothing: the GitHub and
 * Slack buttons disable their own queries on an empty id, read the resulting
 * absence of a role as "not an admin", and tell the user — who may well be the
 * admin — to go and ask one.
 *
 * Shared rather than duplicated because the steps that need it live in
 * different files: the external integrations on each of the setup tabs.
 */
export function WorkspaceUnavailable() {
  return (
    <p className="text-[12px] text-muted-foreground">
      This project&apos;s workspace could not be loaded, so this step is unavailable. Reload the
      page to try again.
    </p>
  );
}
