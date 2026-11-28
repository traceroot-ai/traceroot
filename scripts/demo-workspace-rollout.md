# Demo workspace opt-in rollout

Existing VIEWER memberships do not record whether a user requested demo access.
The reset command removes those memberships so users can explicitly join again.
It preserves ADMIN and MEMBER roles and all other workspaces. It never adds users.

1. Pause demo joining and drain the old app instances that grant membership on
   sign-up or session creation. Keep this maintenance window until the reset and
   deployment finish; otherwise an old instance can re-add viewers or the reset
   can remove users who have just opted in.
2. Review the shared project's published content, including alerts, datasets,
   assistant transcripts, RCA results and trace payloads. Include scorer and
   evaluation-run definitions (model choices, judge messages/prompts and source
   code), run metadata, and automatically recorded RCA/message metadata, models
   and providers. Publish only approved samples; remove or replace internal
   working content before reopening demo access. API response filtering does not
   sanitize free-form stored content.
3. Set `DATABASE_URL` and `DEMO_WORKSPACE_ID` for the deployment, then inspect the
   dry-run count:

   ```sh
   python scripts/reset_demo_workspace_members.py --workspace-id "$DEMO_WORKSPACE_ID"
   ```

4. After confirming the target and affected members, apply the one-time reset:

   ```sh
   python scripts/reset_demo_workspace_members.py --workspace-id "$DEMO_WORKSPACE_ID" --apply
   ```

5. Update the REST service before starting the updated UI instances. The REST
   service restricts detector configuration when an older UI omits the demo access
   flag; an older REST service does not enforce that restriction. Verify both
   services are updated before reopening demo joining.
6. Verify that a new account and a returning viewer have no demo membership until
   they request it. Check explicit join, leave
   and sign-in again, along with the demo's read-only and settings restrictions.

Do not rerun the reset after opening opt-in: it also removes newly opted-in VIEWER
memberships. A dry run is safe at any time. Do not restore the old automatic-join
code as a rollback; stop demo access while resolving any deployment failure.
