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
 * routes**. That is the present state, not a conclusion: the key an SDK carries
 * is the one minted for ingestion, and it is what reports eval results today,
 * so demanding `admin` here would break every existing caller. Narrowing it —
 * most plausibly for dataset publishing, which is project authoring rather than
 * telemetry — is a deliberate change that needs its own answer for keys already
 * issued. The hook is here so that change is one argument at one route.
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
