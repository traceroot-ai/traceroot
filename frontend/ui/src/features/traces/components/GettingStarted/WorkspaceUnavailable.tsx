/**
 * Stands in for a workspace-scoped step when there is no workspace to scope it
 * to.
 *
 * An errored project fetch is not a loading state: react-query drops
 * `isLoading` with no data behind it, so rendering either of these steps on
 * `!isLoading` alone hands it an empty workspace id. That is worse than
 * nothing. `ModelProviderBlock` disables its own queries on an empty id, reads
 * the resulting absence of a role as "not an admin", and tells the user — who
 * may well be the admin — to go and ask one, via a link to
 * `/workspaces//settings/model-providers` that 404s.
 *
 * Shared rather than duplicated because the steps that need it live in
 * different files: the external integrations on each of the traces page's two
 * tabs, and the model key field wherever that is asked for.
 */
export function WorkspaceUnavailable() {
  return (
    <p className="text-[12px] text-muted-foreground">
      This project&apos;s workspace could not be loaded, so this step is unavailable. Reload the
      page to try again.
    </p>
  );
}
