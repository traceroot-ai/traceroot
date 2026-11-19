import { NextResponse } from "next/server";
import { resolveApiKeyProject, type ApiKeyScope } from "@/lib/public-auth";

/**
 * Resolve the project for an API-key-authenticated request on the SDK reporting
 * surface (`/api/public/...`): `Authorization: Bearer tr-…`, hashed and looked
 * up against `AccessKey.secretHash`. Kept in the Next.js app so the reporting
 * path is locally testable without the Python hop.
 *
 * Deliberately *not* named `requireApiKeyProject`. That name belongs to the
 * Bearer public API helper in `lib/public-auth.ts`, and two exports with one
 * name and different guarantees is a wrong auto-import waiting to happen. Both
 * now go through one `resolveApiKeyProject`, so the rules about what makes a
 * key acceptable live in a single place; this function only maps the outcome
 * onto the `{error}` bodies and wording that this surface's shipped SDK clients
 * already parse.
 *
 * `require` is accepted but no route passes it, so **both `ingest` and `admin`
 * keys may currently perform the dataset and evaluation-run writes behind these
 * routes**. That is deliberate, and the reason is not the obvious one.
 *
 * Keys issued before scoping were backfilled to `admin`, so narrowing a route
 * would not disturb them. It is *new* keys that would break: every key minted
 * today is `ingest` (see the mint in `api/projects/[projectId]/api-keys`). And
 * the eval SDK authors datasets with that same credential by design — a
 * non-local `evaluate()` publishes its local dataset as part of running the
 * eval, which is a `POST /datasets` and a `POST /datasets/[datasetId]/versions`
 * carrying the tracing SDK's `TRACEROOT_API_KEY` (docs `evals/running-evals`,
 * `evals/get-started`). Requiring `admin` for dataset authoring would therefore
 * harden no existing deployment while making `evaluate()` fail for every
 * project created from here on; this surface's own exercisers, which drive
 * A1–A5 with an `ingest` key, are the statement of that intent.
 *
 * So the split this surface wants is not a `require` argument away. It needs
 * either a credential the eval SDK can carry for authoring — which first needs
 * any way at all to mint an `admin` key, i.e. the key-management surface rather
 * than this change — or a rule narrower than two scopes, along the lines of an
 * `ingest` key being allowed to version the dataset it is reporting a run
 * against and nothing else. Until one of those exists, the hook is here so that
 * change is one argument at one route.
 */
export async function requireEvalApiKeyProject(
  request: Request,
  options: { require?: ApiKeyScope } = {},
): Promise<{ projectId: string; error?: never } | { projectId?: never; error: NextResponse }> {
  const result = await resolveApiKeyProject(request, options);
  if (result.ok) {
    return { projectId: result.auth.projectId };
  }
  switch (result.reason) {
    case "missing_token":
      return { error: NextResponse.json({ error: "Missing bearer API key" }, { status: 401 }) };
    case "expired":
      return { error: NextResponse.json({ error: "API key expired" }, { status: 401 }) };
    case "not_found":
    case "project_deleted":
      // One message for both: which of the two it was is information an
      // unauthenticated caller has not earned.
      return { error: NextResponse.json({ error: "Invalid API key" }, { status: 401 }) };
    case "insufficient_scope":
      // 403, not 401: the key is genuine, so re-authenticating cannot help.
      return {
        error: NextResponse.json(
          { error: "This API key is scoped to telemetry ingestion and cannot perform this write." },
          { status: 403 },
        ),
      };
  }
}
